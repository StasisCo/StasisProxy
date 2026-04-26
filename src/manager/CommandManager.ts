import { AsyncLocalStorage } from "async_hooks";
import { Command, CommanderError } from "commander";
import { readdir } from "fs/promises";
import type { Bot, Player } from "mineflayer";
import { join } from "path";
import { Client } from "~/class/Client";

interface CommandContext {
	player: Player;
	method: "whisper" | "chat" | "irc";
}

export class CommandManager {

	private static program: Command;
	private static store = new AsyncLocalStorage<CommandContext>();

	public static get context(): CommandContext {
		const ctx = this.store.getStore();
		if (!ctx) throw new Error("Command context accessed outside of a command handler");
		return ctx;
	}

	public static async handle(username: string, input: string, method: "whisper" | "chat" | "irc" = "whisper") {
		const player = Client.bot.players[username];
		if (!player) return;

		const [ command, ...args ] = input.trim().split(/\s+/);
		const tokens = command ? [ command.toLowerCase(), ...args ] : [];

		await this.store.run({ player, method }, async() => {
			try {
				await this.program.parseAsync(tokens, { from: "user" });
			} catch (error) {

				// Silently ignore unknown commands from IRC and public chat
				if (error instanceof CommanderError && error.code === "commander.unknownCommand" && method !== "whisper") {
					return;
				}

				// Commander throws on unknown commands / validation errors
				if (error instanceof Error) {
					Client.chat.whisper(player, error.message);
				}
			}
		});
	}

	constructor(private readonly bot: Bot) {
		const program = new Command();
		program.exitOverride();
		program.allowExcessArguments();
		program.configureOutput({
			writeOut: () => {},
			writeErr: () => {}
		});

		CommandManager.program = program;
		this.loadCommands();
	}

	private async loadCommands() {
		const dir = join(import.meta.dir, "..", "commands");
		const files = await readdir(dir);

		for (const file of files) {
			if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
			const mod = await import(join(dir, file));
			if (typeof mod.default === "function") mod.default(CommandManager.program);
		}

	}

}