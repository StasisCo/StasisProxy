import { zMojangUsername } from "@hackware/types/schema/mojang/zUsername";
import chalk from "chalk";
import { execSync } from "child_process";
import type { SessionObject } from "minecraft-protocol";
import { createBot, type BotOptions } from "mineflayer";
import z from "zod";
import { Logger } from "~/class/Logger";
import { ChatCommandManager } from "~/manager/ChatCommandManager";
import { ChatManager } from "~/manager/ChatManager";
import { DiscordManager } from "~/manager/DiscordManager";
import { PathfindingManager } from "~/manager/PathfindingManager";
import { PhysicsManager } from "~/manager/PhysicsManager";
import { QueueManager } from "~/manager/QueueManager";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { logger as redisLogger, redisSub } from "~/redis";
import { zPeerRequest } from "~/schema/zPeerRequest";
import { name, version } from "../../package.json";
import { Console } from "./Console";
import { Server } from "./proxy/Server";

export class Client {

	/** User agent string to identify the client version */
	public static readonly userAgent = `${ name }/${ version }+${ execSync("git rev-parse HEAD").toString().trim() }`;

	/** Logger instance */
	public static logger = new Logger(chalk.cyan("CLIENT"));
	
	/** Resolved server host after connection; used for namespacing Redis channels and database records by server */
	public static host?: string;

	/** Minecraft protocol session object, set after successful login and used for accessing the bot's profile and other session-specific data */
	public static session?: SessionObject;

	/// /////////////////////////////////////////////

	/** Console instance for interactive command input */
	public static console?: Console;

	/** Exit code to use when the process exits; set to 0 for clean exits, or 1 for errors */
	private static exitCode = 1;

	/** Gracefully disconnects the bot and exits the process with the specified exit code (default is 1 for errors, or 0 for clean exits) */
	public static exit(code = 1) {
		this.exitCode = code;
		Client.bot.quit();
	}

	public static readonly options: BotOptions = {
		auth: "microsoft",
		brand: Client.userAgent,
		logErrors: false,
		host: z.string().parse(process.env.MC_HOST?.split(":")[0]),
		port: parseInt(z.string().optional().parse(process.env.MC_HOST)?.split(":")[1] ?? "25565"),
		profilesFolder: z.string().optional().parse(process.env.MC_PROFILE),
		username: zMojangUsername.parse(process.env.MC_USERNAME),
		version: z.string().refine(val => /\d+\.\d+(\.\d+)?/.test(val), "Invalid Minecraft version format").optional().parse(process.env.MC_VERSION)
	};

	public static readonly bot = createBot(this.options);

	public static readonly proxy = new Server(this.bot);
	public static readonly chat = new ChatManager(this.bot);
	public static readonly commands = new ChatCommandManager(this.bot);
	public static readonly discord = new DiscordManager(this.bot);
	public static readonly pathfinding = new PathfindingManager(this.bot);
	public static readonly physics = new PhysicsManager(this.bot);
	public static readonly queue = new QueueManager(this.bot);
	public static readonly stasis = new StasisManager(this.bot);

	static {

		// Handle graceful shutdown on SIGINT and SIGTERM signals
		process.once("SIGTERM", () => this.exit(0));
		process.once("SIGINT", () => this.exit(0));

		// Handle upstream connection
		this.logger.log("Connecting to server:", chalk.cyan.underline(this.options.host + ":" + this.options.port) + "...");

		// Handle general bot errors
		this.bot.on("error", err => this.logger.error(err));

		// Handle upstream disconnects
		this.bot.on("kicked", reason => {
			const component = new ChatManager.parser(JSON.parse(reason));
			Client.logger.warn("Disconnected:", component.toAnsi());
			this.proxy.kickAll(component);
			Client.exit(1);
		});

		// On bot disconnect
		this.bot.on("end", () => {
			this.proxy.close();
			process.exit(this.exitCode);
		});

		// Handle account resolution
		Client.bot._client.on("session", (session: SessionObject) => {
			Client.logger.log("Logged in as:", chalk.cyan.underline(session.selectedProfile.name), chalk.dim(session.selectedProfile.id));
			Client.session = session;
		});

		// Handle upstream connection
		Client.bot._client.on("connect", async() => {

			// Resolve _host
			const socket = Client.bot._client.socket;
			if (socket) Client.host = "_host" in socket && typeof socket._host === "string" ? socket._host : undefined;

			// Fallback to configured host if resolution failed 
			if (!Client.host) {
				Client.logger.warn("Could not resolve server host from socket, falling back to MC_HOST environment variable");
				Client.host = Client.options.host;
			}

			Client.logger.log("Connected to server:", chalk.cyan.underline(Client.host));

			if (!Client.session) {
				Client.logger.error("Session object is not available after connection");
				return Client.exit(1);
			}

			// Normalize ID
			const botId = Client.session.selectedProfile.id.replace(/([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})/, "$1-$2-$3-$4-$5");

			// Upsert bot player in database
			await prisma.player.upsert({ where: { id: botId }, update: { username: Client.session.selectedProfile.name }, create: { id: botId, username: Client.session.selectedProfile.name }});
			await prisma.bot.upsert({ where: { id: botId }, update: {}, create: { player: { connect: { id: botId }}}});

			// Unclaim any stasis previously owned by this bot on the same server (in case of unclean shutdown)
			const { count } = await prisma.stasis.updateMany({ where: { botId, server: Client.host }, data: { botId: null }});
			if (count > 0) StasisManager.logger.log(`Disconnected ${ chalk.yellow(count) } managed stasis on ${ chalk.cyan.underline(Client.host) }`);

			// Subscribe to this bot's command channel so peers can request pearl loads
			const channel = `${ name }:cluster:${ Client.host }:${ botId }:queue`;
			await redisSub.subscribe(channel, async(raw: string) => {
				
				// Log the received message for debugging purposes
				const { data, success } = zPeerRequest.safeParse(JSON.parse(raw));
				if (!success) return redisLogger.warn("Received invalid message on", chalk.cyan(channel), raw);
				
				switch (data.type) {

					default:
						redisLogger.warn("Received unknown message type on", raw);
						break;

					// Peer is requesting a stasis load for a player
					case "load": {
						redisLogger.log(`Received load request for player ${ chalk.cyan(data.player) }`);
						await StasisManager.enqueue(data.player, data.status);
						break;
					}

				}

			}).then(() => redisLogger.log(`Subscribed to ${ chalk.cyan(channel) }`));
			
		});

	}

}
