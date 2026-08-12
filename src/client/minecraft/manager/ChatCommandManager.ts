import { AsyncLocalStorage } from "async_hooks";
import { Command, CommanderError } from "commander";
import { readdir } from "fs/promises";
import type { Player } from "mineflayer";
import { join } from "path";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { Module } from "~/client/minecraft/Module";
import type Presence from "~/client/minecraft/module/Presence";
import { prisma } from "~/prisma";
import { normalizeUUID } from "~/utils";

interface CommandContext {
	player: Player;
	method: "whisper" | "chat" | "irc" | "dm";
}

export class ChatCommandManager {

	private static initialized = false;
	private static program: Command;
	private static store = new AsyncLocalStorage<CommandContext>();

	public static get context(): CommandContext {
		const ctx = this.store.getStore();
		if (!ctx) throw new Error("Command context accessed outside of a command handler");
		return ctx;
	}

	/**
	 * Whether the sender may run owner-level commands. Same access rule as connecting to the
	 * proxy: whitelisted in the client table, or the bot's own account.
	 */
	public static async isWhitelisted(player: Player): Promise<boolean> {
		const senderId = normalizeUUID(player.uuid);
		const botId = MinecraftClient.bot._client.session?.selectedProfile.id;
		if (botId !== undefined && senderId === normalizeUUID(botId)) return true;

		const record = await prisma.client.findUnique({ where: { id: senderId }});
		return record?.whitelisted === true;
	}

	/**
	 * Send the current command's sender a response, over whatever channel suits
	 * how they asked: IRC direct messages are answered with IRC chat, everything
	 * else with an in-game whisper.
	 */
	public static reply(text: string) {
		const { player, method } = this.context;
		if (method === "dm") void Module.get<Presence>("Presence").postChat(text);
		else MinecraftClient.chat.whisper(player, text);
	}

	public static async handle(username: string, input: string, method: CommandContext["method"] = "whisper") {
		const player = MinecraftClient.bot.players[username];
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
					this.reply(error.message);
				}
			}
		});
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
		const dir = join(import.meta.dir, "..", "commands");
		const files = await readdir(dir);

		for (const file of files) {
			if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
			const mod = await import(join(dir, file));
			if (typeof mod.default === "function") mod.default(this.program);
		}
	}

}