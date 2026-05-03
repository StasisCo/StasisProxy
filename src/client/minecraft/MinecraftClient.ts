import { zMojangUsername } from "@hackware/types/schema/mojang/zUsername";
import chalk from "chalk";
import { execSync } from "child_process";
import type { SessionObject } from "minecraft-protocol";
import { createBot, type Bot, type BotOptions } from "mineflayer";
import prettyMilliseconds from "pretty-ms";
import z from "zod";
import type { Console } from "~/class/Console";
import { Logger } from "~/class/Logger";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";
import { ChatManager } from "~/client/minecraft/manager/ChatManager";
import { PathfindingManager } from "~/client/minecraft/manager/PathfindingManager";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { prisma } from "~/prisma";
import { redis } from "~/redis";
import { ClientCommands } from "~/server/minecraft/ClientCommands";
import { Server } from "~/server/minecraft/Server";
import { normalizeUUID } from "~/utils";
import { name, version } from "../../../package.json";
import { Module } from "./Module";
import { PhysicsManager } from "./manager/PhysicsManager";
import { QueueManager } from "./manager/QueueManager";

const RECONNECT_DELAY_MS = 5_000;

export class MinecraftClient {

	/** User agent string to identify the client version */
	public static readonly userAgent = `${ name }/${ version }+${ execSync("git rev-parse HEAD").toString().trim() }`;

	/** Logger instance */
	public static logger = new Logger(chalk.cyan("CLIENT"));

	/** Console instance for interactive command input */
	public static console?: Console;

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

	/** Resolved server host after connection; used for namespacing Redis channels and database records by server */
	public static host?: string;

	/** Minecraft protocol session object, set after successful login and used for accessing the bot's profile and other session-specific data */
	public static session?: SessionObject;

	/** The mineflayer bot instance — recreated on each connection. */
	public static bot: Bot;

	public static proxy: Server;
	public static chat: ChatManager;
	public static pathfinding: PathfindingManager;
	public static physics: PhysicsManager;
	public static queue: QueueManager;
	public static stasis: StasisManager;

	/** Exit code to use when the process exits; set to 0 for clean exits, or 1 for errors */
	private static exitCode = 1;

	/** Redis channel currently subscribed for peer requests, to avoid duplicate subscriptions */
	private static redisChannel?: Redis.ValidChannel;

	/** Gracefully disconnects the bot and exits the process with the specified exit code (default is 1 for errors, or 0 for clean exits) */
	public static exit(code = 1) {
		this.exitCode = code;
		this.bot.quit();
	}

	/** Create a new mineflayer bot and (re)initialize all managers. */
	public static connect() {
		this.session = undefined;
		this.host = undefined;
		this.exitCode = 1;

		// Tear down previous connection's resources
		this.physics?.stop();
		this.chat?.close();
		this.proxy?.close();

		// Create fresh bot and managers
		this.bot = createBot(this.options);
		this.proxy = new Server(this.bot);
		this.chat = new ChatManager(this.bot);
		this.pathfinding = new PathfindingManager(this.bot);
		this.physics = new PhysicsManager(this.bot);
		this.queue = new QueueManager(this.bot);
		this.stasis = new StasisManager(this.bot);

		// Rebind the console's event listeners to the new bot
		this.console?.rebind(this.bot);

		this.logger.log("Connecting to server:", chalk.cyan.underline(this.options.host + ":" + this.options.port) + "...");
		const connectTime = Date.now();

		// Handle general bot errors
		this.bot.on("error", err => this.logger.error(err));

		// Handle upstream disconnects
		this.bot.on("kicked", reason => {
			const component = new ChatManager.parser(JSON.parse(reason));
			this.logger.warn("Disconnected:", component.toAnsi());
			this.proxy.kickAll(component);
		});

		// On bot disconnect — reconnect automatically unless exit(0) was called
		this.bot.on("end", () => {
			this.proxy.close();
			if (this.exitCode === 0) return process.exit(0);
			this.logger.warn(`Reconnecting in ${ RECONNECT_DELAY_MS / 1000 }s...`);
			setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
		});

		// Handle account resolution
		this.bot._client.on("session", (session: SessionObject) => {
			this.logger.log("Authenticated as", chalk.cyan(session.selectedProfile.name), chalk.dim(`(${ normalizeUUID(session.selectedProfile.id) })`), "in", chalk.yellow(prettyMilliseconds(Date.now() - connectTime)));
			this.session = session;
		});

		// Handle upstream connection
		this.bot._client.on("connect", async() => {

			// Resolve _host
			const socket = this.bot._client.socket;
			if (socket) this.host = "_host" in socket && typeof socket._host === "string" ? socket._host : undefined;

			// Fallback to configured host if resolution failed
			if (!this.host) {
				this.logger.warn("Could not resolve server host from socket, falling back to MC_HOST environment variable");
				this.host = this.options.host;
			}

			if (!this.host) {
				this.logger.error("Server host is not defined. Please set the MC_HOST environment variable.");
				return this.exit(1);
			}

			this.logger.log("Connected to server:", chalk.cyan.underline(this.host), "in", chalk.yellow(prettyMilliseconds(Date.now() - connectTime)));

			if (!this.session) {
				this.logger.error("Session object is not available after connection");
				return this.exit(1);
			}

			// Normalize ID
			const id = normalizeUUID(this.session.selectedProfile.id);

			// Upsert bot player in database
			await prisma.player.upsert({ where: { id }, update: { username: this.session.selectedProfile.name }, create: { id, username: this.session.selectedProfile.name }});
			await prisma.bot.upsert({ where: { id }, update: {}, create: { player: { connect: { id }}}});

			// Subscribe to the cluster channel for this bot to receive peer requests (only once)
			const channel = `stasisproxy:cluster:${ this.host }` as const;
			if (this.redisChannel !== channel) {
				if (this.redisChannel) await redis.off(this.redisChannel);
				this.redisChannel = channel;
				await redis.on(channel, async data => {

					switch (data.type) {

						default:
							redis.logger.warn("Peer send unknown message format");
							break;

						case "bot-connect":
							redis.logger.log(`Added peer to pool: ${ chalk.cyan(data.bot.name) } ${ chalk.dim(`(${ data.bot.id })`) }`);
							break;

						case "request-load":
							if (data.destinationUuid !== id) return;
							redis.logger.log(`Received peer request for player ${ chalk.cyan(data.playerUuid) }`);
							await StasisManager.enqueue(data.playerUuid, data.statusKey);
							break;

					}
				}).then(() => redis.logger.log(`Subscribed to ${ chalk.cyan(channel) }`));
			}

			// Notify cluster of this bot's connection so peers can send requests
			await redis.emit(channel, {
				type: "bot-connect",
				bot: {
					id,
					name: this.session.selectedProfile.name,
					version: MinecraftClient.userAgent
				}
			});

		});

		// Rebind modules to the new bot
		Module.rebind();
	}

	static {
		process.once("SIGTERM", () => this.exit(0));
		process.once("SIGINT", () => this.exit(0));

		void ChatCommandManager.init();
		void ClientCommands.init();

		this.connect();
	}

}
