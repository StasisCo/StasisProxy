import chalk from "chalk";
import mineflayer from "mineflayer";
import { Movements, pathfinder } from "mineflayer-pathfinder";
import prismarineChat from "prismarine-chat";
import { unwrapNbtLike } from "../utils";
import { printObject } from "../utils/format";
import { Logger } from "./Logger";

export class Bot {

	public static instance: mineflayer.Bot;
	private static queuePosition: number | undefined;
	private static queuedAt: number | undefined;

	/**
     * Login the bot
     * @returns The bot instance
     */
	public static async connect() {

		// Validate env variables
		if (!process.env.MC_HOST) throw new Error("Env variable 'MC_HOST' not set. This should be the IP address of the Minecraft server.");
		if (!process.env.MC_USERNAME) throw new Error("Env variable 'MC_USERNAME' not set. This should be the email of the Microsoft account to use.");
		if (!process.env.MC_PASSWORD) throw new Error("Env variable 'MC_PASSWORD' not set. This should be the password of the Microsoft account to use.");

		// Create the bot
		Logger.log(`Connecting to host ${ chalk.cyan(process.env.MC_HOST) }...`);
		const bot = this.instance = mineflayer.createBot({
			auth: "microsoft",
			host: process.env.MC_HOST,
			password: process.env.MC_PASSWORD,
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
		bot.once("login", () => Logger.log(`Connected to host ${ chalk.cyan(process.env.MC_HOST) } as ${ chalk.cyan(bot.username) }`));

		// Log disconnect reason
		bot.once("kicked", function(reason) {
			if (typeof reason === "string" && (reason.startsWith("{") || reason.startsWith("["))) reason = JSON.parse(reason);
			const ChatMessage = prismarineChat(Bot.instance.version);
			const msg = new ChatMessage(unwrapNbtLike(reason));
			Logger.error(`Disconnected from server: ${ chalk.red(msg.toAnsi()) }`);
		});

		// Log queue position changes
		bot.on("title", (title, subtitle) => {
			if (this.queuePosition === undefined) return;
			const match = title.toString().match(/Position in queue: (\d+)/);
			if (!match) return;
			const newPos = parseInt(match[1] || "-1");
			if (this.queuePosition !== newPos) {
				this.queuePosition = newPos;
				Logger.log(`Position in queue: ${ chalk.yellow(this.queuePosition) }`);
			}
		});

		// Exit on disconnect with an error code
		bot.on("end", () => process.exit(1));

		// Load pathfinder
		bot.loadPlugin(pathfinder);

		// Start a wait for spawn
		let isWaitingForSpawn = true;
		bot.once("spawn", () => void (isWaitingForSpawn = false));

		// Avoid resolving in the queue server
		await new Promise<void>(resolve => bot.on("game", () => {

			// Make sure were not in 2b2t queue
			if (bot.game.dimension === "the_end" && bot.game.gameMode === "spectator") {
				if (this.queuePosition === undefined) {
					Logger.warn("In queue, getting position...");
					this.queuePosition = -1;
					this.queuedAt = Date.now();
				}
				return;
			}

			// If were leaving the queue server,
			if (this.queuePosition !== undefined) {
				this.queuePosition = undefined;
				const queuedFor = Date.now() - (this.queuedAt || Date.now());
				Logger.log(`Queued for ${ chalk.yellow((queuedFor / 1000).toFixed(0) + " seconds") }`);
			}

			resolve();

		}));

		// Wait for spawn
		if (isWaitingForSpawn) await new Promise<void>(resolve => bot.once("spawn", () => resolve()));

		Logger.log(`Loading dimension ${ chalk.cyan(bot.game.dimension) }...`);
		printObject({
			difficulty: bot.game.difficulty,
			gamemode: bot.game.gameMode,
			version: bot.version
		});

		// Setup pathing movements
		const movements = new Movements(bot);
		bot.pathfinder.setMovements(movements);

		return bot;

	}

}