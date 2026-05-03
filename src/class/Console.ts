import chalk from "chalk";
import type { Bot as Mineflayer } from "mineflayer";
import { createInterface, type Interface } from "readline";
import { ClientCommands } from "~/server/minecraft/ClientCommands";
import { Logger } from "./Logger";

export class Console {

	private readonly rl: Interface;

	/** Completions extracted from the server's declare_commands packet */
	private completions: string[] = [];

	private bot: Mineflayer;

	constructor(bot: Mineflayer) {
		this.bot = bot;

		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: chalk.gray("> "),
			completer: (line: string, cb: (err: null, result: [string[], string]) => void) => {
				this.tabComplete(line).then(hits => cb(null, [ hits, line ]));
			}
		});

		Logger.setRenderHook(() => this.rl.prompt(true));
		this.rl.prompt();

		this.rl.on("line", line => {
			const trimmed = line.trim();
			if (!trimmed) {
				this.rl.prompt();
				return;
			}

			if (trimmed.startsWith("/")) {
				void ClientCommands.tryHandleConsole(trimmed.slice(1)).then(handled => {
					if (!handled) this.bot.chat(trimmed);
					this.rl.prompt();
				});
				return;
			}

			this.bot.chat(trimmed);
			this.rl.prompt();
		});

		this.rl.on("close", () => {
			Logger.setRenderHook(null);
			this.bot.quit();
			process.exit(0);
		});

		this.bindBot();
	}

	/** Re-bind event listeners to a new bot instance after reconnect. */
	public rebind(bot: Mineflayer) {
		this.bot = bot;
		this.completions = [];
		this.bindBot();
	}

	private bindBot() {
		this.bot._client.on("declare_commands", (packet: Packets.Schema["declare_commands"]) => {
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
	private async tabComplete(line: string): Promise<string[]> {
		const text = line.trimStart();

		// For slash commands, resolve proxy completions (including arguments)
		// then fall back to the server's declare_commands cache.
		if (text.startsWith("/")) {
			const proxyHits = await ClientCommands.resolveCompletions(text.slice(1));
			if (proxyHits.length > 0) return proxyHits;

			return this.completions.filter(c => c.startsWith(text));
		}

		// For plain chat, complete from online player names
		const players = Object.keys(this.bot.players);
		if (!text) return players;
		return players.filter(p => p.toLowerCase().startsWith(text.toLowerCase()));
	}

}
