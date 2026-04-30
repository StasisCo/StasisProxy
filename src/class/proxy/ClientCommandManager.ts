import chalk from "chalk";
import type { Client as MinecraftClient, PacketMeta } from "minecraft-protocol";
import { Logger } from "~/class/Logger";
import { ClientCommand, type ClientCommandContext } from "./ClientCommand";
import type { ServerClient } from "./ServerClient";

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
 * Per-connection registry that:
 * 1. Holds {@link ClientCommand} instances keyed by name.
 * 2. Intercepts client→server `chat_command` (and slash-prefixed `chat`)
 *    packets, dispatching known commands locally and forwarding unknown ones.
 * 3. Mutates `declare_commands` packets so registered commands appear in the
 *    client's tab-completion alongside the upstream server's commands.
 */
export class ClientCommandManager {

	private readonly commands = new Map<string, ClientCommand>();

	constructor(private readonly serverClient: ServerClient) {}

	/** Register a command. Re-registration with the same name overwrites. */
	public register(command: ClientCommand): this {
		this.commands.set(command.name.toLowerCase(), command);
		return this;
	}

	/** Iterate registered commands. */
	public values(): IterableIterator<ClientCommand> {
		return this.commands.values();
	}

	/**
	 * Try to handle a raw command line (without leading `/`). Returns `true`
	 * when the command was handled locally and must NOT be forwarded upstream;
	 * `false` when the command is unknown and the caller should forward.
	 */
	public async tryHandle(client: MinecraftClient, raw: string): Promise<boolean> {
		const trimmed = raw.trim();
		if (!trimmed) return false;

		const [ name, ...args ] = trimmed.split(/\s+/);
		const command = this.commands.get(name!.toLowerCase());
		if (!command) return false;

		const ctx: ClientCommandContext = {
			client,
			bot: this.serverClient.bot,
			serverClient: this.serverClient
		};

		try {
			await command.execute(args, ctx);
		} catch (err) {
			this.sendSystemMessage(client, `§cError: ${ err instanceof Error ? err.message : String(err) }`);
		}

		return true;
	}

	/**
	 * Mutate a parsed `declare_commands` packet to advertise our registered
	 * commands as literal nodes attached to the root. Each command becomes a
	 * `has_command` literal so the client renders it in tab-completion. Args
	 * are deliberately omitted — the client still allows free-form text after
	 * the literal name.
	 *
	 * Returns the same `data` reference for convenience (mutated in place).
	 */
	public decorateDeclareCommands(data: DeclareCommandsData): DeclareCommandsData {
		const root = data.nodes[data.rootIndex];
		if (!root || root.flags.command_node_type !== 0) return data;

		// Drop any literals we previously injected so re-decoration is idempotent.
		const ourNames = new Set([ ...this.commands.keys() ]);
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

		// Append a literal node for each registered command.
		for (const command of this.commands.values()) {
			const lowered = command.name.toLowerCase();

			// If the upstream server already advertises this command, skip — overwriting
			// would shadow the server's argument tree (which we don't reproduce).
			if (existingLiteralNames.has(lowered)) continue;

			const newIdx = data.nodes.length;
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
				extraNodeData: { name: lowered }
			});
			root.children.push(newIdx);
		}

		return data;
	}

	/**
	 * Inspect a single client→server packet. Returns `true` if the manager
	 * consumed it (do NOT forward upstream); `false` otherwise.
	 *
	 * Handles both `chat_command` (modern, no leading `/`) and `chat` payloads
	 * that start with `/` (pre-1.19 fallback).
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	public async interceptClientPacket(client: MinecraftClient, data: any, meta: PacketMeta): Promise<boolean> {
		if (meta.name === "chat_command" || meta.name === "chat_command_signed") {
			const raw: string = data?.command ?? "";
			return await this.tryHandle(client, raw);
		}

		if (meta.name === "chat") {
			const raw: string = data?.message ?? "";
			if (!raw.startsWith("/")) return false;
			return await this.tryHandle(client, raw.slice(1));
		}

		return false;
	}

	/** Send a yellow system chat message to the client. */
	public sendSystemMessage(client: MinecraftClient, text: string) {
		const component = JSON.stringify({ text });
		try {

			// system_chat (1.19+). If the client version doesn't have it,
			// minecraft-protocol throws and we silently drop the feedback.
			client.write("system_chat", { content: component, isActionBar: false });
		} catch {
			try {
				client.write("chat", { message: component, position: 1, sender: "00000000-0000-0000-0000-000000000000" });
			} catch { /* nothing more we can do */ }
		}
	}

}
