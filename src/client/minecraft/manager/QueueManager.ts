import chalk from "chalk";
import { EventEmitter } from "events";
import stringify from "fast-json-stable-stringify";
import type { PacketMeta } from "minecraft-protocol";
import { type Bot, type GameState } from "mineflayer";
import prettyMilliseconds from "pretty-ms";
import { ChatMessage } from "prismarine-chat";
import z from "zod";
import { Logger } from "~/class/Logger";
import { ChatManager } from "~/client/minecraft/manager/ChatManager";
import { redis } from "~/redis";
import { MinecraftClient } from "../MinecraftClient";

const zQueueEta = z.object({
	factor: z.number(),
	pow: z.number()
});

export class QueueManager extends EventEmitter<{
    
	/**
     * Emitted when the queue position changes
     * @param position The new queue position
     */
	"position-change": [ number ],

	/**
     * Emitted when the bot leaves the queue
     * @param duration The total time spent in the queue in milliseconds
     */
	"leave-queue": [ number ]

}> {

	/** Static logger instance for the QueueManager class */
	private static logger = new Logger(chalk.yellow("QUEUE"));

	// ETA calculation parameters
	private readonly queueEta = { factor: 0, pow: 0 };

	/**
     * Checks if the given game state indicates that the bot is currently in the queue
     * @param GameState The current game state to check
     * @returns True if the game state indicates the bot is in the queue, false otherwise
     */
	public static isQueued(game?: GameState): boolean {
		if (!game) return false;
		return game.gameMode === "spectator" && game.dimension === "the_end";
	}

	/**
     * Checks the current game state to determine if the bot is still in the queue, and emits a 
     * "leave-queue" event if it has left the queue
     */
	private readonly checkQueueState = () => {
		if (this.isQueued) return;
		this.bot.off("game", this.checkQueueState);
		this.bot._client.off("packet", this.onPacket);
		QueueManager.logger.log("Finished queueing after", chalk.yellow(prettyMilliseconds(this.elapsed)));
		this.emit("leave-queue", this.elapsed);
	};

	private queuedAt = -1;
	private startingPosition: number | null = null;
	public subtitle: ChatMessage | null = null;
	public title: ChatMessage | null = null;

	constructor(private readonly bot: Bot) {
		super();
		if (bot.game) this.attach();
		bot.once("game", () => this.attach());
	}

	private lastChatMessage: ChatMessage | null = null;

	private attach() {
		if (!QueueManager.isQueued(this.bot.game)) return;
		QueueManager.logger.log("Started queueing, waiting for position updates...");
		this.queuedAt = performance.now();
		this.bot.on("game", this.checkQueueState);
		this.bot._client.on("packet", this.onPacket);
	}

	/**
     * Checks if the bot is currently in the queue by examining the current game state
     * @returns True if the bot is in the queue, false otherwise
     */
	public get isQueued(): boolean {
		return this.bot.game ? QueueManager.isQueued(this.bot.game) : true;
	}

	/**
     * Gets the elapsed time since the bot started queueing
     * @returns The elapsed time in milliseconds
     */
	public get elapsed(): number {
		return performance.now() - this.queuedAt;
	}

	/**
	 * Gets the current queue position by parsing the title and subtitle for the position text
	 * @return The current queue position, or null if not in the queue
	 */
	public get position(): number | null {
		if (!this.subtitle) return null;
		const match = this.subtitle.toString().match(/Position in queue: (\d+)/);
		if (!match || !match[1]) return null;
		this.startingPosition ??= Math.max(parseInt(match[1], 10), this.startingPosition ?? 0);

		return parseInt(match[1], 10);
	}

	/**
	 * Calculates the estimated time remaining in the queue based on the current position
	 * @returns The estimated time remaining in milliseconds, or null if it cannot be calculated
	 */
	public get eta(): number | null {
		const position = this.position;
		if (position === null) return null;
		if (this.startingPosition && this.startingPosition <= 100) return null;
		const { factor, pow } = this.queueEta;
		if (factor === 0 || pow === 0) return null;
		const eta = factor * Math.pow(position, pow);
		return isNaN(eta) ? null : eta;
	}

	/**
     * Handles incoming packets to track queue position changes. Specifically looks for the "set_title_subtitle" 
     * packet to extract the queue position from the subtitle text, and emits a "position-change" event if the 
     * position has changed.
	 * @param _packet The raw packet data received from the server
	 * @param name The name of the packet, used to identify which packets to process
     */
	private readonly onPacket = (_packet: unknown, { name }: PacketMeta) => {
		const event = { name, data: _packet } as Packets.PacketEvent;
		switch (event.name) {

			case "system_chat": {
				const parsed = new ChatManager.parser(typeof event.data.content === "string" ? JSON.parse(event.data.content) : ChatManager.nbtToChat(event.data.content));
				if (!this.lastChatMessage || parsed.toAnsi() !== this.lastChatMessage.toAnsi()) {
					const chat = ChatManager.normalizeAnsiWhitespace(parsed.toAnsi());
					QueueManager.logger.log(chat);
				}
				this.lastChatMessage = parsed;
				break;
			}

			case "set_title_subtitle": {
				const { position } = this;
				this.subtitle = new ChatManager.parser(typeof event.data.text === "string" ? JSON.parse(event.data.text) : event.data.text);
				if (position !== this.position && this.position !== null) {
					QueueManager.logger.log(`Position in queue: ${ chalk.yellow(this.position) }`, (this.eta ? `ETA: ${ chalk.yellow(prettyMilliseconds(this.eta * 1000)) }` : ""));
					switch (MinecraftClient.host) {

						case "connect.2b2t.org": {
							redis.get(`queue:${ MinecraftClient.host }:eta`)
								.then(zQueueEta.parseAsync)
								.catch(() => fetch("https://api.2b2t.vc/queue/eta-equation")
									.then(res => res.json())
									.then(zQueueEta.parseAsync)
									.then(({ factor, pow }) => {
										redis.set(`queue:${ MinecraftClient.host }:eta`, stringify({ factor, pow }), "EX", "600");
										return { factor, pow };
									}))
								.then(({ factor, pow }) => Object.assign(this.queueEta, { factor, pow }));
							break;
						}
						
					}

					this.emit("position-change", this.position);

				}

				break;
			}

			case "set_title_text": {
				this.title = new ChatManager.parser(typeof event.data.text === "string" ? JSON.parse(event.data.text) : event.data.text);
				break;
			}
			
		}
        
	};

}