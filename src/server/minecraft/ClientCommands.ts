import { AsyncLocalStorage } from "async_hooks";
import chalk from "chalk";
import { Command, CommanderError } from "commander";
import { readdir } from "fs/promises";
import type { Client as MinecraftClient, PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { join } from "path";
import ChatMessageConstructor from "prismarine-chat";
import { Logger } from "~/class/Logger";
import type { ServerClient } from "./ServerClient";

/** A single completion level: static literals or a function returning them. */
export type CompletionLevel = string[] | (() => string[] | Promise<string[]>);

/**
 * Execution context available to every client command via
 * {@link ClientCommands.context}.
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
	extraNodeData?: {
		name?: string;
		parser?: string;
		properties?: unknown;
		suggestionType?: string;
	};
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
export class ClientCommands {

	private static readonly logger = new Logger(chalk.blue("PROXY"));
	private static readonly ChatMessage = ChatMessageConstructor(`${ process.env.MC_VERSION }`);

	private static initialized = false;
	private static program: Command;
	private static store = new AsyncLocalStorage<ClientCommandContext>();

	/** Per-command Brigadier completions, keyed by command name. */
	private static completions = new Map<string, CompletionLevel[]>();

	public static get context(): ClientCommandContext {
		const ctx = this.store.getStore();
		if (!ctx) throw new Error("Command context accessed outside of a command handler");
		return ctx;
	}

	/** Whether we're currently inside a client command context (vs console). */
	public static get hasContext(): boolean {
		return this.store.getStore() !== undefined;
	}

	/** Convert Minecraft `§x` colour codes to ANSI sequences via prismarine-chat. */
	private static mcToAnsi(text: string): string {
		return new this.ChatMessage(text).toAnsi();
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

	/** Send a red error message: `§c<text>`. */
	public static error(text: string) {
		this.reply(`§cError: §4${ text }`);
	}

	/** Send a formatted usage hint: `§eUsage: §7/<syntax>`. */
	public static usage(syntax: Command) {
		return this.reply(`§eUsage: §f/${ syntax.name() } ${ syntax.usage() }`);
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
		const dir = join(import.meta.dir, "commands");
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
					this.sendSystemMessage(client, `§cError: §4${ error.message.substring(6).trim() }`);
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

			// Append children for each completion level.
			const levels = this.completions.get(name);
			if (levels) {
				let parentIndices = [ cmdIdx ];
				for (const level of levels) {
					const nextParents: number[] = [];

					if (typeof level === "function") {

						// Dynamic level — argument node with ask_server suggestions.
						const childIdx = data.nodes.length;
						data.nodes.push({
							flags: {
								unused: 0,
								allows_restricted: 0,
								has_custom_suggestions: 1,
								has_redirect_node: 0,
								has_command: 1,
								command_node_type: 2
							},
							children: [],
							extraNodeData: {
								name: "arg",
								parser: "brigadier:string",
								properties: 0,
								suggestionType: "minecraft:ask_server"
							}
						});
						for (const pi of parentIndices) data.nodes[pi]!.children.push(childIdx);
						nextParents.push(childIdx);
					} else {

						// Static level — literal nodes for each option.
						for (const option of level) {
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
					}

					parentIndices = nextParents;
				}
			}
		}

		return data;
	}

	/**
	 * Handle a `tab_complete` (C→S) packet for our commands. Resolves
	 * dynamic (function) completion levels and responds directly.
	 * Returns `true` if handled; `false` to forward upstream.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	private static async handleTabComplete(client: MinecraftClient, data: any): Promise<boolean> {
		const text: string = data?.text ?? "";
		const raw = text.startsWith("/") ? text.slice(1) : text;
		const parts = raw.split(/\s+/);
		const cmdName = parts[0]?.toLowerCase();

		if (!cmdName) return false;

		const known = this.program.commands.some(c => c.name() === cmdName || c.aliases().includes(cmdName));
		if (!known) return false;

		const levels = this.completions.get(cmdName);
		if (!levels) return false;

		// parts[0] = command name, parts[1..] = arguments.
		// argIndex maps to the completions level array.
		const argIndex = parts.length - 2;
		if (argIndex < 0 || argIndex >= levels.length) return false;

		const level = levels[argIndex];
		if (!level || typeof level !== "function") return false;

		const options = await level();
		const partial = parts[parts.length - 1] ?? "";
		const filtered = partial
			? options.filter(o => o.toLowerCase().startsWith(partial.toLowerCase()))
			: options;

		const start = text.length - partial.length;

		client.write("tab_complete", {
			transactionId: data.transactionId,
			start,
			length: partial.length,
			matches: filtered.map(m => ({ match: m }))
		});

		return true;
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

		if (meta.name === "tab_complete") {
			return await this.handleTabComplete(client, data);
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
	 * Resolve completions for a partial command line (without leading `/`).
	 * Returns matching options synchronously for static levels, or via
	 * promise for dynamic levels. Used by the console tab-completer.
	 */
	public static async resolveCompletions(line: string): Promise<string[]> {
		const parts = line.split(/\s+/);
		const cmdName = parts[0]?.toLowerCase();
		if (!cmdName) return [];

		// Complete the command name itself.
		if (parts.length === 1) {
			return this.commandNames.filter(n => n.startsWith(cmdName)).map(n => `/${ n }`);
		}

		const levels = this.completions.get(cmdName);
		if (!levels) return [];

		const argIndex = parts.length - 2;
		if (argIndex < 0 || argIndex >= levels.length) return [];

		const level = levels[argIndex]!;
		const options = typeof level === "function" ? await level() : level;
		const partial = parts[parts.length - 1] ?? "";
		const prefix = `/${ parts.slice(0, -1).join(" ") } `;

		return options
			.filter(o => o.toLowerCase().startsWith(partial.toLowerCase()))
			.map(o => `${ prefix }${ o }`);
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
			if (error instanceof Error) this.logger.error(chalk.redBright("Error:"), chalk.red(error.message.substring(6).trim()));
		}

		return true;
	}

}
