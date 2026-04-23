import chalk from "chalk";
import type { Bot as Mineflayer } from "mineflayer";
import { createInterface, type Interface } from "readline";
import { Logger } from "./Logger";

export class Console {

	private readonly rl: Interface;

	/** Completions extracted from the server's declare_commands packet */
	private completions: string[] = [];

	constructor(private readonly bot: Mineflayer) {
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: chalk.gray("> "),
			completer: (line: string) => [ this.tabComplete(line), line ]
		});

		Logger.setRenderHook(() => this.rl.prompt(true));
		this.rl.prompt();

		this.rl.on("line", line => {
			const trimmed = line.trim();
			if (trimmed) bot.chat(trimmed);
			this.rl.prompt();
		});

		this.rl.on("close", () => {
			Logger.setRenderHook(null);
			bot.quit();
			process.exit(0);
		});

		// The server sends declare_commands on login with the full command tree.
		// Extract the names of all top-level literal nodes (direct children of root)
		// and store them as completions prefixed with "/".
		bot._client.on("declare_commands", (packet: Packets.Schema["declare_commands"]) => {
			const root = packet.nodes[packet.rootIndex];
			if (!root) return;

			const commands = root.children
				.map(i => packet.nodes[i])
				.filter((n): n is Packets.Schema["declare_commands"]["nodes"][number] => !!n && n.flags.command_node_type === 1)
				.map(n => `/${ n.extraNodeData?.name ?? "" }`)
				.filter(c => c.length > 1);

			if (commands.length > 0) this.completions = commands;
		});
	}

	/** Filter cached completions for the current readline input */
	private tabComplete(line: string): string[] {
		const text = line.trimStart();

		// For slash commands, filter from the declare_commands cache
		if (text.startsWith("/")) {
			return this.completions.filter(c => c.startsWith(text));
		}

		// For plain chat, complete from online player names
		const players = Object.keys(this.bot.players);
		if (!text) return players;
		return players.filter(p => p.toLowerCase().startsWith(text.toLowerCase()));
	}

}
