import chalk from "chalk";
import mineflayer from "mineflayer";
import { Movements, pathfinder } from "mineflayer-pathfinder";
import { printAnsiChat } from "../utils";
import { Logger } from "./Logger";

export class Bot {

	private static instance: mineflayer.Bot;

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
		const bot = this.instance = mineflayer.createBot({
			auth: "microsoft",
			host: process.env.MC_HOST,
			password: process.env.MC_PASSWORD,
			port: parseInt(process.env.MC_HOST.split(":")[1] || "25565"),
			username: process.env.MC_USERNAME,
			version: process.env.MC_VERSION
		});

		// Exit on disconnect
		bot.on("end", () => process.exit(1));
		
		// Log kicks and chat
		bot.on("kicked", reason => Logger.error("Disconnected:", printAnsiChat(typeof reason === "string" ? JSON.parse(reason) : reason)));

		// Log chat messages
		bot.on("message", username => Logger.log(chalk.gray("[CHAT]"), username.toAnsi()));

		// Load pathfinder
		bot.loadPlugin(pathfinder);

		// Avoid resolving in the queue server
		await new Promise<void>(resolve => bot.on("game", () => {

			// Make sure were not in 2b2t queue
			if (bot.game.dimension === "the_end" && bot.game.gameMode === "spectator") return;

			resolve();

		}));

		// Setup pathing movements
		bot.once("spawn", () => {
			const movements = new Movements(bot);
			bot.pathfinder.setMovements(movements);
		});

		return bot;

	}

	public static get bot() {
		if (!this.instance) throw new Error("Bot not initialized yet. Call Bot.connect() first.");
		return this.instance;
	}

}