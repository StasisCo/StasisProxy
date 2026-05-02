import { randomBytes } from "crypto";
import { type Bot as Mineflayer, type Player } from "mineflayer";
import ChatMessageConstructor from "prismarine-chat";
import z from "zod";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ConfigManager } from "../../../manager/ConfigManager";
import { ChatCommandManager } from "./ChatCommandManager";

export const zChatCommandsSchema = z.object({
	prefix: z
		.string()
		.default("!")
		.describe("Prefix for chat commands (e.g. \"!\" → \"!load\")")
});

export const chatCommandsConfig = ConfigManager.initGeneral("general.chatcommands", zChatCommandsSchema);

export class ChatManager {

	private static readonly whisperQueue = new Map<string, { message: string; timestamp: number, retries?: number }>();

	private static logger = new Logger("CHAT");

	public static readonly parser = ChatMessageConstructor(`${ process.env.MC_VERSION }`);

	/**
	 * Recursively unwrap a protodef-parsed NBT value into a plain chat component object.
	 * In 1.20.3+ system_chat content arrives as binary NBT, not a JSON string.
	 */
	public static nbtToChat(nbt: unknown): unknown {
		if (typeof nbt !== "object" || nbt === null) return nbt;
		if ("type" in nbt && "value" in nbt) {
			if (nbt.type === "compound") {
				return Object.fromEntries(
					Object.entries(nbt.value as Record<string, unknown>).map(([ k, v ]) => [ k, ChatManager.nbtToChat(v) ])
				);
			}
			if (nbt.type === "list") {
				const list = nbt.value as { type: string; value: unknown[] };
				return list.value.map((v: unknown) => ChatManager.nbtToChat({ type: list.type, value: v }));
			}
			return nbt.value;
		}
		return nbt;
	}

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

	/** Collapse and trim visible whitespace while preserving ANSI color sequences */
	public static normalizeAnsiWhitespace(text: string): string {
		let result = "";
		let started = false;
		let pendingSpace = false;

		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 27 && text[i + 1] === "[") {
				const start = i;
				i += 2;
				while (i < text.length && !((text[i]! >= "@" && text[i]! <= "~"))) i++;
				result += text.slice(start, i + 1);
				continue;
			}

			if (/\s/.test(text[i]!)) {
				if (started) pendingSpace = true;
				continue;
			}

			if (pendingSpace) {
				result += " ";
				pendingSpace = false;
			}

			result += text[i];
			started = true;
		}

		return result;
	}

	/** Calculate the pixel width of Minecraft-formatted text */
	private static getPixelWidth(text: string): number {
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
		bot._client.on("system_chat", async function(packet: Packets.Schema["system_chat"]) {
			if (MinecraftClient.queue.isQueued) return;

			// Parsed chat message objects can be deeply nested due to the way Minecraft formats text with extra components, translations, and selectors. We need to recursively unwrap these into a single string for logging.
			const parsed = new ChatManager.parser(typeof packet.content === "string" ? JSON.parse(packet.content) : ChatManager.nbtToChat(packet.content));
			ChatManager.logger.log(ChatManager.normalizeAnsiWhitespace(parsed.toAnsi()));

		});
		
		// Handle whisper commands
		bot.on("whisper", async(username, message) => {

			// Prefix is optional for whisper commands, but if present, should be removed before command parsing
			if (message.toLowerCase().trim().startsWith(chatCommandsConfig.prefix.toLowerCase().trim())) {
				message = message.trim().slice(chatCommandsConfig.prefix.length).trim();
			}

			const command = message.trim();
			await ChatCommandManager.handle(username, command, "whisper");

		});

		// Handle public chat commands
		bot.on("chat", async(username, message) => {

			// Parse out green text
			if (message.trim().startsWith(">")) message = message.trim().slice(1).trim();

			// Ignore messages that don't start with the command prefix
			if (!message.toLowerCase().startsWith(chatCommandsConfig.prefix.toLowerCase())) return;

			const command = message.trim().slice(chatCommandsConfig.prefix.length).trim();
			await ChatCommandManager.handle(username, command, "chat");

		});

		setInterval(this.processQueue.bind(this));
		
	}

	private lastWhisper = -1;

	private processQueue() {

		// If lastWhisper was more then 2s ago
		if (Date.now() - this.lastWhisper < 2000) return;

		const next = Array.from(ChatManager.whisperQueue.entries())
			.sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
		if (!next) return;

		const sanitized = next[1].message.trim().replace(/\n|\r/g, " ");
		const chars = [];
		for (const char of sanitized.split("")) {
			chars.push(char);
			const length = Math.floor(Math.random() * 3);
			for (let i = 0; i < length; i++) chars.push("\u200C".repeat(Math.floor(Math.random() * ((next[1].retries ?? 0) + 1))));
		}
		const msg = `${ chars.join("") } [${ randomBytes(6).toString("hex") }]`;

		MinecraftClient.bot.chat(`/w ${ next[0] } ${ msg }`.slice(0, 256));
		ChatManager.whisperQueue.set(next[0], { ...next[1], retries: (next[1].retries ?? 0) + 1 });
		this.lastWhisper = Date.now();

		const onSystemMessage = (packet: Packets.Schema["system_chat"]) => {
			const content = new ChatManager.parser(typeof packet.content === "string" ? JSON.parse(packet.content) : ChatManager.nbtToChat(packet.content));
			if (content.toString().replace(/\u200C/g, "").endsWith(msg.replace(/\u200C/g, ""))) {
				MinecraftClient.bot._client.off("system_chat", onSystemMessage);
				ChatManager.whisperQueue.delete(next[0]);
			}
		};

		MinecraftClient.bot._client.on("system_chat", onSystemMessage);

	}

	public whisper(player: Player, message: string) {
		ChatManager.whisperQueue.set(player.username, {
			timestamp: Date.now(),
			message: `${ message.trim().replace(/\n|\r/g, " ") }`
		});
	}

}