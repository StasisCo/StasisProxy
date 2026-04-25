import { zMojangUsername } from "@hackware/types/schema/mojang/zUsername";
import chalk from "chalk";
import { execSync } from "child_process";
import mcDataLoader from "minecraft-data";
import { createBot, type BotOptions } from "mineflayer";
import z from "zod";
import { Logger } from "~/class/Logger";
import { ChatManager } from "~/manager/ChatManager";
import { CommandManager } from "~/manager/CommandManager";
import { DiscordManager } from "~/manager/DiscordManager";
import { ModuleManager } from "~/manager/ModuleManager";
import { PathfindingManager } from "~/manager/PathfindingManager";
import { PhysicsManager } from "~/manager/PhysicsManager";
import { PresenceManager } from "~/manager/PresenceManager";
import { QueueManager } from "~/manager/QueueManager";
import { RelationManager } from "~/manager/RelationManager";
import { StasisManager } from "~/manager/StasisManager";
import { name, version } from "../../package.json";
import { Console } from "./Console";
import { Proxy } from "./Proxy";

export class Client {

	private static logger = new Logger(chalk.blue("CLIENT"));

	public static console?: Console;

	private static exitCode = 0;

	public static readonly options: BotOptions = {
		auth: "microsoft",
		brand: `${ name }/${ version }+${ execSync("git rev-parse HEAD").toString().trim() }`,

		/**
		 * The hostname of the Minecraft server to connect to, parsed from the MC_HOST environment variable
		 */
		host: z.string().parse(process.env.MC_HOST).split(":")[0],

		/**
		 * The port of the Minecraft server to connect to, parsed from the MC_PORT environment variable, with a default value of 25565 if not provided
		 */
		port: parseInt(z.string().optional().parse(process.env.MC_HOST)?.split(":")[1] ?? "25565"),

		/**
		 * The folder where Minecraft profiles are stored, parsed from the MC_PROFILE environment variable, or undefined if not provided
		 */
		profilesFolder: z.string().optional().parse(process.env.MC_PROFILE),

		/**
		 * The Minecraft username to use for authentication, parsed from the MC_USERNAME environment variable and validated using the zMojangUsername schema
		 */
		username: zMojangUsername.parse(process.env.MC_USERNAME),

		/**
		 * The Minecraft version to use for the bot, parsed from the MC_VERSION environment variable and validated to ensure it follows a valid version format (e.g., "1.16.5", "1.17", etc.). 
		 * If not provided, it will be undefined, allowing mineflayer to auto-detect the version based on the server's response during login.
		 */
		version: z.string().refine(val => /\d+\.\d+(\.\d+)?/.test(val), "Invalid Minecraft version format").optional().parse(process.env.MC_VERSION)

	};
	
	public static readonly bot = createBot(this.options);
	public static readonly registry = mcDataLoader(this.bot.version);

	public static host = "";

	// Register connect handler BEFORE managers so Client.host is resolved
	// when PresenceManager's "connect"/"session" handlers fire.
	static {
		this.logger.log("Connecting to server:", chalk.cyan.underline(this.options.host + ":" + this.options.port) + "...");
		Client.bot._client.on("connect", () => {
			const socket = Client.bot._client.socket;
			if (socket) Client.host = ("_host" in socket && typeof socket._host === "string")
				? socket._host
				: (Client.options.host ?? "");
			Client.logger.log("Connected to server:", chalk.cyan.underline(Client.host));
		});
	}
	
	public static readonly proxy = new Proxy(this.bot);
	public static readonly chat = new ChatManager(this.bot);
	public static readonly presence = process.env.IRC_HOST ? new PresenceManager(this.bot) : null;
	public static readonly commands = new CommandManager(this.bot);
	public static readonly discord = new DiscordManager(this.bot);
	public static readonly modules = new ModuleManager(this.bot);
	public static readonly pathfinding = new PathfindingManager(this.bot);
	public static readonly physics = new PhysicsManager(this.bot);
	public static readonly queue = new QueueManager(this.bot);
	public static readonly relations = new RelationManager(this.bot);
	public static readonly stasis = new StasisManager(this.bot);

	static {

		// Handle disconnection
		this.bot.on("kicked", reason => {
			const component = new ChatManager.parser(JSON.parse(reason));
			Client.logger.warn("Disconnected:", component.toAnsi());
			this.exitCode = 1;
			Client.bot.quit();
		});

		this.bot.on("error", err => {
			console.error("Bot error:", err);
		});

		this.bot.on("end", () => {
			this.proxy.close();
			process.exit(this.exitCode);
		});

	}

}