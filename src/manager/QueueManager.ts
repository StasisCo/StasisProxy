import chalk from "chalk";
import { EventEmitter } from "events";
import type { PacketMeta } from "minecraft-protocol";
import { type Bot, type GameState } from "mineflayer";
import prettyMilliseconds from "pretty-ms";
import { ChatMessage } from "prismarine-chat";
import { Logger } from "~/class/Logger";
import { ChatManager } from "./ChatManager";

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

	private static logger = new Logger(chalk.yellow("QUEUE"));

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
		if (this.queued) return;
		this.bot.off("game", this.checkQueueState);
		this.bot._client.off("packet", this.onPacket);
		QueueManager.logger.log("Finished queueing after", chalk.yellow(prettyMilliseconds(this.elapsed)));
		this.emit("leave-queue", this.elapsed);
	};

	private queuedAt = performance.now();
	private startingPosition: number | null = null;
	public subtitle?: ChatMessage;
	public title?: ChatMessage;

	constructor(private readonly bot: Bot) {
		super();

		// If game state is already available, try to start tracking immediately
		if (bot.game) {
			this.tryStartTracking();
		} else {

			// Wait for the first game event before checking queue state
			bot.once("game", () => this.tryStartTracking());
		}

	}

	private tryStartTracking() {
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
	public get queued(): boolean {
		return QueueManager.isQueued(this.bot.game);
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

	public get message(): ChatMessage | null {
		return this.subtitle || null;
	}

	/**
     * Handles incoming packets to track queue position changes. Specifically looks for the "set_title_subtitle" 
     * packet to extract the queue position from the subtitle text, and emits a "position-change" event if the 
     * position has changed.
     * @param packet The incoming packet payload to process
     * @param param1 The packet metadata containing the packet name
     */
	private readonly onPacket = (_packet: unknown, { name }: PacketMeta) => {
		const event = { name, data: _packet } as Packets.PacketEvent;
		switch (event.name) {

			case "set_title_subtitle": {
				const { position } = this;
				this.subtitle = new ChatManager.parser(JSON.parse(event.data.text));
				if (position !== this.position && this.position !== null) {
					QueueManager.logger.log(`Position in queue: ${ chalk.yellow(this.position) }`);
					this.emit("position-change", this.position);
				}
				break;
			}

			case "set_title_text": {
				this.title = new ChatManager.parser(JSON.parse(event.data.text));
				break;
			}
			
		}
        
	};

}