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
import { Stasis } from "~/client/minecraft/Stasis";
import { prisma } from "~/prisma";
import { redis } from "~/redis";
import { zMojangUsername } from "~/schema/mojang/zUsername";
import { ClientCommands } from "~/server/minecraft/ClientCommands";
import { Server } from "~/server/minecraft/Server";
import { normalizeUUID } from "~/utils";
import { name, version } from "../../../package.json";
import { InteractionManager } from "./manager/InteractionManager";
import { PhysicsManager } from "./manager/PhysicsManager";
import { QueueManager } from "./manager/QueueManager";
import type { RotationManager } from "./manager/RotationManager";
import { Module } from "./Module";

/** Exponential backoff schedule for automatic reconnects. After the final (5m) attempt fails, the process exits. */
const RECONNECT_DELAYS_MS = [ 0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 120_000, 300_000 ];

/** How long shutdown cleanup gets before the process is terminated regardless. */
const SHUTDOWN_GRACE_MS = 3_000;

/** How often the bot renews its cluster-wide presence key, and how long that key outlives the last renewal. */
const PRESENCE_INTERVAL_MS = 10_000;
const PRESENCE_TTL_S = "30";

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
		version: z.string().refine(val => /\d+\.\d+(\.\d+)?/.test(val), "Invalid Minecraft version format").optional().parse(process.env.MC_VERSION),

		// Requested view distance in chunks. The dominant CPU cost on constrained hosts is
		// packet parsing, and it scales with what the server sends — a smaller view distance
		// culls chunk, block-update and far-entity traffic at the source. Per-bot via env:
		// set low (e.g. 4) for bots stationed at entity-dense farms on small containers.
		viewDistance: process.env.MC_VIEW_DISTANCE ? z.coerce.number().int().min(2).max(32).parse(process.env.MC_VIEW_DISTANCE) : "far"
	};

	/** Resolved server host after connection; used for namespacing Redis channels and database records by server */
	public static host?: string;

	/** Minecraft protocol session object, set after successful login and used for accessing the bot's profile and other session-specific data */
	public static session?: SessionObject;

	/** The mineflayer bot instance — recreated on each connection. */
	public static bot: Bot;

	public static proxy: Server;
	public static chat: ChatManager;
	public static interaction: InteractionManager;
	public static pathfinding: PathfindingManager;
	public static physics: PhysicsManager;
	public static queue: QueueManager;
	public static rotation: RotationManager;
	public static stasis: StasisManager;

	/** Exit code to use when the process exits; set to 0 for clean exits, or 1 for errors */
	private static exitCode = 1;

	/** Whether a reconnect has already been scheduled for the current connection cycle */
	private static reconnecting = false;

	/** Index into RECONNECT_DELAYS_MS for the next reconnect attempt; reset to 0 on a successful login */
	private static reconnectAttempt = 0;

	/** Redis channel currently subscribed for peer requests, to avoid duplicate subscriptions */
	private static redisChannel?: Redis.ValidChannel;

	/** Whether a shutdown is already in progress, so a second interrupt can bypass cleanup. */
	private static exiting = false;

	/** The presence key currently held in Redis, so it can be deleted promptly on disconnect rather than waiting for the TTL. */
	private static presenceKey?: `stasisproxy:bot:online:${ string }`;

	/**
	 * Advertise this bot as online cluster-wide. Any container can win the Discord interaction
	 * claim — including one that is queueing or reconnecting — so "is bot X online, and on which
	 * server" must be answerable without consulting the local connection's tab list. While logged
	 * in past the queue, the bot's UUID maps to its server host in Redis; the key expires on its
	 * own if the process dies without cleanup.
	 */
	private static async presenceTick() {
		const id = this.session?.selectedProfile.id;
		if (!id || !this.host || !this.bot?.player || this.queue?.isQueued !== false) return this.clearPresence();
		this.presenceKey = `stasisproxy:bot:online:${ normalizeUUID(id) }`;
		await redis.set(this.presenceKey, { host: this.host }, "EX", PRESENCE_TTL_S).catch(() => undefined);
	}

	/** Remove this bot's presence key, if one is held. */
	private static async clearPresence() {
		const key = this.presenceKey;
		if (!key) return;
		this.presenceKey = undefined;
		await redis.del(key).catch(() => undefined);
	}

	/**
	 * Gracefully disconnects the bot and exits the process with the specified exit code
	 * (default is 1 for errors, or 0 for clean exits).
	 */
	public static exit(code = 1) {
		this.exitCode = code;

		// A non-zero code means "drop this connection"; the end handler reconnects from there.
		// Only a clean exit is an actual shutdown.
		if (code !== 0) {
			this.bot?.quit();
			return;
		}

		// Asked twice — go now, whatever the cleanup is doing.
		if (this.exiting) process.exit(code);
		this.exiting = true;

		// Stop everything that writes upstream *before* closing the connection. The physics loop
		// ticks every 50 ms and would otherwise keep feeding position packets into a stream that
		// is already ending — and its interval alone is enough to keep the event loop alive
		// forever, since nothing else ever clears it.
		this.physics?.stop();
		this.proxy?.close();

		// Releasing stasis management talks to a remote database, and the process holds open a
		// Redis connection and a readline handle besides. None of that may be allowed to keep us
		// running: the protocol library only destroys the socket 30 seconds after a graceful
		// close, so a process that lingers is a bot that stays online until the server times it
		// out. Cleanup is best-effort against this deadline.
		setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS).unref();

		this.bot?.quit();
	}

	/** Schedule an automatic reconnect using exponential backoff. Once every backoff step has been exhausted, exit the container. */
	private static scheduleReconnect() {
		if (this.exitCode === 0) return;
		if (this.reconnecting) return;
		this.reconnecting = true;

		// Exhausted every backoff step — give up so the container can restart from a clean state
		if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
			this.logger.error(`Failed to reconnect after ${ RECONNECT_DELAYS_MS.length } attempts, exiting.`);
			return process.exit(1);
		}

		const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++]!;
		this.logger.warn(`Reconnecting in ${ prettyMilliseconds(delay) }... (attempt ${ this.reconnectAttempt }/${ RECONNECT_DELAYS_MS.length })`);
		setTimeout(() => this.connect(), delay);
	}

	/** Create a new mineflayer bot and (re)initialize all managers. */
	public static connect() {
		this.session = undefined;
		this.host = undefined;
		this.exitCode = 1;
		this.reconnecting = false;

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
		this.rotation = this.physics.rotation;
		this.interaction = new InteractionManager(this.bot);
		this.queue = new QueueManager(this.bot);
		this.stasis = new StasisManager(this.bot);

		// Advertise presence as soon as the queue is cleared instead of waiting out the heartbeat interval
		this.queue.once("leave-queue", () => void this.presenceTick());

		// Rebind the console's event listeners to the new bot
		this.console?.rebind(this.bot);

		this.logger.log("Connecting to server:", chalk.cyan.underline(this.options.host + ":" + this.options.port) + "...");
		const connectTime = Date.now();

		// Handle general bot errors — if the bot isn't connected yet, trigger reconnect
		// (auth failures don't emit `end`, so the bot would sit dead without this)
		this.bot.on("error", err => {
			this.logger.error(err);

			if (!this.bot.player) this.scheduleReconnect();
		});

		// Handle upstream disconnects
		this.bot.on("kicked", reason => {
			try {
				const component = new ChatManager.parser(JSON.parse(reason));
				this.logger.warn("Disconnected:", component.toAnsi());
				this.proxy.kickAll(component);
			} catch (err) {
				this.logger.warn("Disconnected:", reason);
				this.logger.error("Error handling kick:", err);
			}

			// Login-phase kicks (e.g. "logging in too fast") may not emit `end`, so trigger reconnect here
			if (!this.bot.player) this.scheduleReconnect();
		});

		// On bot disconnect — reconnect automatically unless exit(0) was called
		this.bot.on("end", async() => {
			try {
				this.proxy.close();
				await this.clearPresence();

				// Release management of all tracked stasis so other bots can pick them up
				for (const stasis of Stasis.instances.values()) await stasis.releaseManagement();
				Stasis.instances.clear();
			} catch (err) {
				this.logger.error("Error during disconnect cleanup:", err);
			}

			if (this.exitCode === 0) return process.exit(0);
			this.scheduleReconnect();
		});

		// Reset the reconnect backoff once we've successfully logged in
		this.bot.once("login", () => {
			this.reconnectAttempt = 0;
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

		setInterval(() => void this.presenceTick(), PRESENCE_INTERVAL_MS);

		void ChatCommandManager.init();
		void ClientCommands.init();

		this.connect();
	}

}
