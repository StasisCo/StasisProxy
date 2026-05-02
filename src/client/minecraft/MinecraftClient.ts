import { zMojangUsername } from "@hackware/types/schema/mojang/zUsername";
import chalk from "chalk";
import { execSync } from "child_process";
import type { SessionObject } from "minecraft-protocol";
import { createBot, type BotOptions } from "mineflayer";
import prettyMilliseconds from "pretty-ms";
import z from "zod";
import { Logger } from "~/class/Logger";
import { Server } from "~/class/proxy/Server";
import { ChatCommandManager } from "~/client/minecraft/ChatCommands";
import { ChatManager } from "~/manager/ChatManager";
import { PathfindingManager } from "~/manager/PathfindingManager";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { logger as redisLogger, redisSub } from "~/redis";
import { zPeerRequest } from "~/schema/zPeerRequest";
import { normalizeUUID } from "~/utils";
import { name, version } from "../../../package.json";
import { PhysicsManager } from "./system/PhysicsManager";
import { QueueManager } from "./system/QueueManager";

export class MinecraftClient {

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
		MinecraftClient.bot.quit();
	}

	public static readonly options: BotOptions = {
		auth: "microsoft",
		brand: MinecraftClient.userAgent,
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
	static {
		void ChatCommandManager.init();
	}
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
			MinecraftClient.logger.warn("Disconnected:", component.toAnsi());
			this.proxy.kickAll(component);
			MinecraftClient.exit(1);
		});

		// On bot disconnect
		this.bot.on("end", () => {
			this.proxy.close();
			process.exit(this.exitCode);
		});

		// Handle account resolution
		const now = Date.now();
		MinecraftClient.bot._client.on("session", (session: SessionObject) => {
			MinecraftClient.logger.log("Authenticated as", chalk.cyan(session.selectedProfile.name), chalk.dim(`(${ normalizeUUID(session.selectedProfile.id) })`), "in", chalk.yellow(prettyMilliseconds(Date.now() - now)));
			MinecraftClient.session = session;
		});

		// Handle upstream connection
		MinecraftClient.bot._client.on("connect", async() => {

			// Resolve _host
			const socket = MinecraftClient.bot._client.socket;
			if (socket) MinecraftClient.host = "_host" in socket && typeof socket._host === "string" ? socket._host : undefined;

			// Fallback to configured host if resolution failed 
			if (!MinecraftClient.host) {
				MinecraftClient.logger.warn("Could not resolve server host from socket, falling back to MC_HOST environment variable");
				MinecraftClient.host = MinecraftClient.options.host;
			}

			MinecraftClient.logger.log("Connected to server:", chalk.cyan.underline(MinecraftClient.host), "in", chalk.yellow(prettyMilliseconds(Date.now() - now)));

			if (!MinecraftClient.session) {
				MinecraftClient.logger.error("Session object is not available after connection");
				return MinecraftClient.exit(1);
			}

			// Normalize ID
			const botId = normalizeUUID(MinecraftClient.session.selectedProfile.id);

			// Upsert bot player in database
			await prisma.player.upsert({ where: { id: botId }, update: { username: MinecraftClient.session.selectedProfile.name }, create: { id: botId, username: MinecraftClient.session.selectedProfile.name }});
			await prisma.bot.upsert({ where: { id: botId }, update: {}, create: { player: { connect: { id: botId }}}});

			// Subscribe to this bot's command channel so peers can request pearl loads
			const channel = `${ name }:cluster:${ MinecraftClient.host }:${ botId }:queue`;
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
