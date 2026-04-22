import chalk from "chalk";
import { randomBytes } from "crypto";
import { type Bot as Mineflayer, type Player } from "mineflayer";
import ChatMessageConstructor from "prismarine-chat";
import { Client } from "~/app/Client";
import { COMMAND_CHAT_PREFIX } from "~/config";
import { Logger } from "~/util/Logger";
import { CommandManager } from "./CommandManager";

export class ChatManager {

	private static logger = new Logger("CHAT");

	/**
     * ChatMessage constructor factory for the current Minecraft version
     */
	public static readonly parser = ChatMessageConstructor(`${ process.env.MC_VERSION }`);

	/** Minecraft default font rendered widths (glyph + 1px gap) */
	private static readonly CHAR_WIDTHS: Record<string, number> = Object.fromEntries([
		..."!.,:;'|i".split("").map(c => [ c, 3 ]),
		..."l`".split("").map(c => [ c, 4 ]),
		..."It\"()*[]{}<> ".split("").map(c => [ c, 5 ]),
		..."~@".split("").map(c => [ c, 7 ])
	]);

	/** Default glyph width (6px) for characters not in the lookup table */
	private static readonly DEFAULT_WIDTH = 6;

	/** Width of a space character (5px) */
	private static readonly SPACE_WIDTH = 5;

	/** Calculate the pixel width of Minecraft-formatted text */
	public static getPixelWidth(text: string): number {
		let width = 0;
		let bold = false;
		for (let i = 0; i < text.length; i++) {
			if (text[i] === "§" && i + 1 < text.length) {
				const code = text[i + 1]!.toLowerCase();
				if (code === "l") bold = true;
				else if (code === "r" || "0123456789abcdef".includes(code)) bold = false;
				i++;
				continue;
			}
			width += (ChatManager.CHAR_WIDTHS[text[i]!] ?? ChatManager.DEFAULT_WIDTH) + (bold ? 1 : 0);
		}
		return width;
	}

	/** Center text within a pixel width, returning a space-padded string */
	public static center(text: string, width: number): string {
		const textWidth = ChatManager.getPixelWidth(text);
		const spaces = Math.max(0, Math.round((width - textWidth) / 2 / ChatManager.SPACE_WIDTH));
		return " ".repeat(spaces) + text;
	}

	constructor(bot: Mineflayer) {

		// Log all system chat messages to the console in a readable format
		bot._client.on("packet", function(packet, { name }) {
			if (name !== "system_chat") return;

			const message = new ChatManager.parser(JSON.parse(packet.content));
			ChatManager.logger.log(message.toAnsi()
				.replaceAll(bot.username, chalk.hex("#FF55FF").underline(bot.username))
			);

		});
		
		bot.on("whisper", async(username, message) => {

			// Prefix is optional for whisper commands, but if present, should be removed before command parsing
			if (message.toLowerCase().trim().startsWith(COMMAND_CHAT_PREFIX.toLowerCase().trim())) {
				message = message.trim().slice(COMMAND_CHAT_PREFIX.length).trim();
			}

			const command = message.trim();
			await CommandManager.handle(username, command, "whisper");

		});

		bot.on("chat", async(username, message) => {

			// Parse out green text
			if (message.trim().startsWith(">")) {
				message = message.trim().slice(1).trim();
			}

			// Ignore messages that don't start with the command prefix
			if (!message.toLowerCase().startsWith(COMMAND_CHAT_PREFIX.toLowerCase())) return;

			const command = message.trim().slice(COMMAND_CHAT_PREFIX.length).trim();
			await CommandManager.handle(username, command, "chat");

		});
		
	}

	public message(player: Player, message: string) {
		Client.bot.chat(`/w ${ player.username } ${ message.trim() } [${ randomBytes(6).toString("hex") }]`);
	}

}