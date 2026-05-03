import { AsyncLocalStorage } from "async_hooks";
import chalk from "chalk";
import { Command, CommanderError } from "commander";
import { readdir } from "fs/promises";
import type { Client as MinecraftClient, PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { join } from "path";
import { Logger } from "~/class/Logger";
import type { ServerClient } from "./ServerClient";

/**
 * Execution context available to every client command via
 * {@link ClientCommandManager.context}.
 */
interface ClientCommandContext {
	client: MinecraftClient;
	bot: Mineflayer;
	serverClient: ServerClient;
}

/**
 * Shape of a single command_node in the `declare_commands` packet
 * (1.13+ Brigadier command graph).
 */
interface CommandNode {
	flags: {
		unused: number;
		allows_restricted: number;
		has_custom_suggestions: number;
		has_redirect_node: number;
		has_command: number;

		/** 0 = root, 1 = literal, 2 = argument */
		command_node_type: number;
	};

	/** Indices into the parent `nodes` array. */
	children: number[];
	redirectNode?: number;
	extraNodeData?: { name?: string };
}

/** Parsed shape of a `declare_commands` packet. */
interface DeclareCommandsData {
	nodes: CommandNode[];
	rootIndex: number;
}

/**
 * Static command registry that:
 * 1. Auto-loads functional command definitions from the `command/` directory.
 * 2. Intercepts client→server `chat_command` (and slash-prefixed `chat`)
 *    packets, dispatching known commands locally and forwarding unknown ones.
 * 3. Mutates `declare_commands` packets so registered commands appear in the
 *    client's tab-completion alongside the upstream server's commands.
 */
export class ClientCommandManager {

	private static readonly logger = new Logger(chalk.blue("PROXY"));

	private static initialized = false;
	private static program: Command;
	private static store = new AsyncLocalStorage<ClientCommandContext>();

	/** Per-command Brigadier literal completions, keyed by command name. */
	private static completions = new Map<string, string[][]>();

	public static get context(): ClientCommandContext {
		const ctx = this.store.getStore();
		if (!ctx) throw new Error("Command context accessed outside of a command handler");
		return ctx;
	}

	/** Whether we're currently inside a client command context (vs console). */
	public static get hasContext(): boolean {
		return this.store.getStore() !== undefined;
	}

	/** Map of Minecraft `§x` colour codes → chalk formatters. */
	private static readonly mcToChalk: Record<string, (s: string) => string> = {
		"0": chalk.black, "1": chalk.blue, "2": chalk.green,
		"3": chalk.cyan, "4": chalk.red, "5": chalk.magenta,
		"6": chalk.yellow, "7": chalk.gray, "8": chalk.blackBright,
		"9": chalk.blueBright, "a": chalk.greenBright, "b": chalk.cyanBright,
		"c": chalk.redBright, "d": chalk.magentaBright, "e": chalk.yellowBright,
		"f": chalk.white, "l": chalk.bold, "n": chalk.underline,
		"o": chalk.italic, "r": chalk.reset
	};

	/** Convert Minecraft `§x` colour codes to chalk ANSI sequences. */
	private static mcToAnsi(text: string): string {
		return text.replace(/§([0-9a-fk-or])(.*?)(?=§|$)/gi, (_, code: string, content: string) => {
			const fn = this.mcToChalk[code.toLowerCase()];
			return fn ? fn(content) : content;
		});
	}

	/**
	 * Send a reply that works from both proxy (system_chat) and console
	 * (logger). Converts `§x` colour codes to ANSI for console output.
	 */
	public static reply(text: string) {
		const ctx = this.store.getStore();
		if (ctx) {
			this.sendSystemMessage(ctx.client, text);
		} else {
			this.logger.log(this.mcToAnsi(text));
		}
	}

	/** Names of all registered commands (for tab-completion decoration). */
	public static get commandNames(): string[] {
		return this.program.commands.map(c => c.name());
	}

	public static async init() {
		if (this.initialized) return;
		this.initialized = true;

		const program = new Command();
		program.exitOverride();
		program.allowExcessArguments();
		program.configureOutput({
			writeOut: () => {},
			writeErr: () => {}
		});

		this.program = program;
		await this.loadCommands();
	}

	private static async loadCommands() {
		const dir = join(import.meta.dir, "command");
		const files = await readdir(dir);

		for (const file of files) {
			if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
			const mod = await import(join(dir, file));
			if (typeof mod.default === "function") mod.default(this.program);
			if (Array.isArray(mod.completions)) {
				const name = file.replace(/\.(ts|js)$/, "");
				this.completions.set(name, mod.completions);
			}
		}
	}

	/**
	 * Try to handle a raw command line (without leading `/`). Returns `true`
	 * when the command was handled locally and must NOT be forwarded upstream;
	 * `false` when the command is unknown and the caller should forward.
	 */
	public static async tryHandle(client: MinecraftClient, serverClient: ServerClient, raw: string): Promise<boolean> {
		const trimmed = raw.trim();
		if (!trimmed) return false;

		const [ name, ...args ] = trimmed.split(/\s+/);
		const tokens = name ? [ name.toLowerCase(), ...args ] : [];

		// Quick-reject: if commander doesn't know the command, return false so
		// the caller can forward the packet upstream.
		const known = this.program.commands.some(c => c.name() === tokens[0] || c.aliases().includes(tokens[0]!));
		if (!known) return false;

		const ctx: ClientCommandContext = {
			client,
			bot: serverClient.bot,
			serverClient
		};

		await this.store.run(ctx, async() => {
			try {
				await this.program.parseAsync(tokens, { from: "user" });
			} catch (error) {
				if (error instanceof CommanderError && error.code === "commander.unknownCommand") return;
				if (error instanceof Error) {
					this.sendSystemMessage(client, `§cError: ${ error.message }`);
				}
			}
		});

		return true;
	}

	/**
	 * Mutate a parsed `declare_commands` packet to advertise our registered
	 * commands as literal nodes attached to the root.
	 */
	public static decorateDeclareCommands(data: DeclareCommandsData): DeclareCommandsData {
		const root = data.nodes[data.rootIndex];
		if (!root || root.flags.command_node_type !== 0) return data;

		const ourNames = new Set(this.commandNames);
		const existingLiteralNames = new Set<string>();
		const childrenToKeep: number[] = [];

		for (const childIdx of root.children) {
			const child = data.nodes[childIdx];
			const childName = child?.extraNodeData?.name?.toLowerCase();
			if (child?.flags.command_node_type === 1 && childName && ourNames.has(childName)) continue;
			childrenToKeep.push(childIdx);
			if (childName) existingLiteralNames.add(childName);
		}
		root.children = childrenToKeep;

		for (const name of ourNames) {
			if (existingLiteralNames.has(name)) continue;

			const cmdIdx = data.nodes.length;
			const cmdNode: CommandNode = {
				flags: {
					unused: 0,
					allows_restricted: 0,
					has_custom_suggestions: 0,
					has_redirect_node: 0,
					has_command: 1,
					command_node_type: 1
				},
				children: [],
				extraNodeData: { name }
			};
			data.nodes.push(cmdNode);
			root.children.push(cmdIdx);

			// Append literal children for each completion level.
			const levels = this.completions.get(name);
			if (levels) {
				let parentIndices = [ cmdIdx ];
				for (const options of levels) {
					const nextParents: number[] = [];
					for (const option of options) {
						const childIdx = data.nodes.length;
						data.nodes.push({
							flags: {
								unused: 0,
								allows_restricted: 0,
								has_custom_suggestions: 0,
								has_redirect_node: 0,
								has_command: 1,
								command_node_type: 1
							},
							children: [],
							extraNodeData: { name: option }
						});
						for (const pi of parentIndices) data.nodes[pi]!.children.push(childIdx);
						nextParents.push(childIdx);
					}
					parentIndices = nextParents;
				}
			}
		}

		return data;
	}

	/**
	 * Inspect a single client→server packet. Returns `true` if the manager
	 * consumed it (do NOT forward upstream); `false` otherwise.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	public static async interceptClientPacket(client: MinecraftClient, serverClient: ServerClient, data: any, meta: PacketMeta): Promise<boolean> {
		if (meta.name === "chat_command" || meta.name === "chat_command_signed") {
			const raw: string = data?.command ?? "";
			return await this.tryHandle(client, serverClient, raw);
		}

		if (meta.name === "chat") {
			const raw: string = data?.message ?? "";
			if (!raw.startsWith("/")) return false;
			return await this.tryHandle(client, serverClient, raw.slice(1));
		}

		return false;
	}

	/** Send a system chat message to the client. */
	public static sendSystemMessage(client: MinecraftClient, text: string) {
		const component = JSON.stringify({ text });
		try {
			client.write("system_chat", { content: component, isActionBar: false });
		} catch {
			try {
				client.write("chat", { message: component, position: 1, sender: "00000000-0000-0000-0000-000000000000" });
			} catch { /* nothing more we can do */ }
		}
	}

	/**
	 * Try to handle a raw command line from the console (without leading `/`).
	 * Runs without a client context — commands that access {@link context}
	 * will throw, which is caught and logged. Returns `true` when the command
	 * was recognised.
	 */
	public static async tryHandleConsole(raw: string): Promise<boolean> {
		const trimmed = raw.trim();
		if (!trimmed) return false;

		const [ name, ...args ] = trimmed.split(/\s+/);
		const tokens = name ? [ name.toLowerCase(), ...args ] : [];

		const known = this.program.commands.some(c => c.name() === tokens[0] || c.aliases().includes(tokens[0]!));
		if (!known) return false;

		try {
			await this.program.parseAsync(tokens, { from: "user" });
		} catch (error) {
			if (error instanceof CommanderError && error.code === "commander.unknownCommand") return false;
			if (error instanceof Error) {
				this.logger.warn(`Command error: ${ error.message }`);
			}
		}

		return true;
	}

}
