import chalk from "chalk";
import mineflayer from "mineflayer";
import { Movements, pathfinder } from "mineflayer-pathfinder";
import pms from "pretty-ms";
import prismarineChat from "prismarine-chat";
import { unwrapNbtLike } from "../utils";
import { printObject } from "../utils/format";
import { Logger } from "./Logger";

export class Bot {

	public static instance: mineflayer.Bot;
	private static queuePosition: number | undefined;
	private static queuedAt: number | undefined;

	/**
	 * Get the server address with port
	 */
	public static get server() {
		return process.env.MC_HOST?.includes(":") ? process.env.MC_HOST : `${ process.env.MC_HOST }:25565`;
	}

	/**
     * Login the bot
     * @returns The bot instance
     */
	public static async connect() {

		// Validate env variables
		if (!process.env.MC_HOST) throw new Error("Env variable 'MC_HOST' not set. This should be the IP address of the Minecraft server.");
		if (!process.env.MC_USERNAME) throw new Error("Env variable 'MC_USERNAME' not set. This should be the email of the Microsoft account to use.");

		// Create the bot
		Logger.log(`Connecting to host ${ chalk.cyan(this.server) }...`);
		const bot = this.instance = mineflayer.createBot({
			auth: "microsoft",
			host: process.env.MC_HOST,
			password: process.env.MC_PASSWORD,
			accessToken: process.env.MC_ACCESS_TOKEN,
			[process.env.MC_REFRESH_TOKEN ? "refreshToken" : ""]: process.env.MC_REFRESH_TOKEN,
			port: parseInt(process.env.MC_HOST.split(":")[1] || "25565"),
			username: process.env.MC_USERNAME,
			version: process.env.MC_VERSION
		});

		// Respawn on death
		bot.on("death", () => {
			bot.clearControlStates();
			bot.pathfinder.stop();
			bot.pathfinder.setGoal(null);
			const write = bot._client.write.bind(bot._client);
			write("client_command", { payload: 0 });
			write("client_command", { actionId: 0 });
			write("client_command", { request: 0 });
		});

		// Log authentication success
		bot.once("login", () => Logger.log(`Connected to host ${ chalk.cyan(this.server) } as ${ chalk.cyan(bot.username) }`));

		// Log disconnect reason
		bot.once("kicked", function(reason) {
			if (typeof reason === "string" && (reason.startsWith("{") || reason.startsWith("["))) reason = JSON.parse(reason);
			const ChatMessage = prismarineChat(Bot.instance.version);
			const msg = new ChatMessage(unwrapNbtLike(reason) as string);
			Logger.error(`Disconnected from server: ${ chalk.red(msg.toAnsi()) }`);
		});

		// Log queue position changes
		bot.on("title", title => {
			if (this.queuePosition === undefined) return;
			const match = title.toString().match(/Position in queue: (\d+)/);
			if (!match) return;
			const newPos = parseInt(match[1] || "-1");
			if (this.queuePosition !== newPos) this.queuePosition = newPos;
		});

		// Exit on disconnect with an error code
		bot.on("end", () => process.exit(1));

		// Load pathfinder
		bot.loadPlugin(pathfinder);

		// Start a wait for spawn
		let isWaitingForSpawn = true;
		bot.once("spawn", () => void (isWaitingForSpawn = false));

		// Avoid resolving in the queue server
		let iv: NodeJS.Timeout | undefined;
		await new Promise<void>(resolve => bot.on("game", () => {

			// Make sure were not in 2b2t queue
			if (bot.game.dimension === "the_end" && bot.game.gameMode === "spectator") {

				if (!iv) iv = setInterval(() => {
					process.stdout.moveCursor(0, -1);
					process.stdout.clearLine(0);
					process.stdout.cursorTo(0);
					if (this.queuePosition === undefined || this.queuePosition === -1) return Logger.warn(`In queue: Unknown position... ${ chalk.yellow(pms(Date.now() - (this.queuedAt || Date.now()))) }`);
					Logger.log(`In queue: Position ${ chalk.yellow(this.queuePosition) }... ${ chalk.yellow(pms(Date.now() - (this.queuedAt || Date.now()), { keepDecimalsOnWholeSeconds: true })) }`);
				}, 50);

				if (this.queuePosition === undefined) {
					Logger.warn("In queue: Unknown position...");
					this.queuePosition = -1;
					this.queuedAt = Date.now();
				}
				return;
			}

			// Clear interval
			if (iv) clearInterval(iv);

			// If were leaving the queue server,
			if (this.queuePosition !== undefined) {
				this.queuePosition = undefined;
				const queuedFor = Date.now() - (this.queuedAt || Date.now());
				process.stdout.moveCursor(0, -1);
				process.stdout.clearLine(0);
				Logger.log(`Left queue after ${ chalk.yellow(pms(queuedFor)) }`);
			}

			resolve();

		}));

		// Wait for spawn
		if (isWaitingForSpawn) await new Promise<void>(resolve => bot.once("spawn", () => resolve()));

		Logger.log("Loading terrain...");
		printObject({
			difficulty: bot.game.difficulty,
			dimension: bot.game.dimension,
			gameMode: bot.game.gameMode,
			version: bot.version
		});

		// Setup pathing movements
		const movements = new Movements(bot);
		bot.pathfinder.setMovements(movements);

		return bot;

	}

}