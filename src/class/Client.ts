import { zMojangUsername } from "@hackware/types/schema/mojang/zUsername";
import { redis } from "bun";
import chalk from "chalk";
import { execSync } from "child_process";
import stringify from "fast-json-stable-stringify";
import { createBot, type BotOptions } from "mineflayer";
import { Vec3 } from "vec3";
import z from "zod";
import { Logger } from "~/class/Logger";
import { ChatManager } from "~/manager/ChatManager";
import { CommandManager } from "~/manager/CommandManager";
import { DiscordManager } from "~/manager/DiscordManager";
import { PathfindingManager } from "~/manager/PathfindingManager";
import { PhysicsManager } from "~/manager/PhysicsManager";
import { PresenceManager } from "~/manager/PresenceManager";
import { QueueManager } from "~/manager/QueueManager";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { logger, redisSub } from "~/redis";
import { name, version } from "../../package.json";
import { Console } from "./Console";
import { Stasis } from "./Stasis";
import { Server } from "./proxy/Server";

export class Client {

	public static logger = new Logger(chalk.cyan("CLIENT"));

	public static console?: Console;

	public static exitCode = 1; // Default to 1 (unexpected disconnect); set to 0 for intentional clean exits

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

	public static host = Client.options.host || "";

	static {
		this.logger.log("Connecting to server:", chalk.cyan.underline(this.options.host + ":" + this.options.port) + "...");
		Client.bot._client.on("connect", async() => {

			// Resolve _host
			const socket = Client.bot._client.socket;
			if (socket) Client.host = "_host" in socket && typeof socket._host === "string" ? socket._host : Client.options.host ?? "";
			Client.logger.log("Connected to server:", chalk.cyan.underline(Client.host));

			// Resolve session
			const session = Client.bot._client.session || await new Promise(resolve => Client.bot._client.once("session", resolve));
			if (!session) throw new Error("Received multiple session events; expected only one per connection");

			// Normalize ID
			const botId = session.selectedProfile.id.replace(/([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})/, "$1-$2-$3-$4-$5");

			// Set last known options in redis
			await redis.set(`bot:${ botId }:options`, stringify(Client.options));

			// Upsert bot player in database
			await prisma.player.upsert({
				where: {
					id: botId
				},
				update: {
					username: session.selectedProfile.name
				},
				create: {
					id: botId,
					username: session.selectedProfile.name
				}
			});

			// Upsert bot record in database to claim ownership of any stasis
			await prisma.bot.upsert({
				where: {
					id: botId
				},
				update: {},
				create: {
					player: {
						connect: {
							id: botId
						}
					}
				}
			});

			// Unclaim any stasis previously owned by this bot on the same server (in case of unclean shutdown)
			const { count } = await prisma.stasis.updateMany({
				where: {
					botId,
					server: Client.host
				},
				data: { botId: null }
			});

			if (count > 0) StasisManager.logger.log(`Disconnected ${ chalk.yellow(count) } managed stasis entr${ count === 1 ? "y" : "ies" } on ${ chalk.cyan.underline(Client.host) }`);

			// Subscribe to this bot's command channel so peers can request pearl loads
			const channel = `bot:${ botId }:commands`;
			await redisSub.subscribe(channel, async(raw: string) => {
				const parsed = await z.object({
					playerUuid: z.uuid(),
					mode: z.enum([ "online", "offline" ]),
					statusKey: z.string()
				}).safeParseAsync(JSON.parse(raw));
				if (!parsed.success) return;

				const { playerUuid, mode, statusKey } = parsed.data;
				logger.log(`Received pearl request for player ${ chalk.cyan(playerUuid) } via peer`);

				const pearls = await Stasis.fetch(playerUuid)
					.then(stasis => stasis.sort((a, b) =>
						a.block.position.distanceTo(Client.bot.entity.position as Vec3) -
						b.block.position.distanceTo(Client.bot.entity.position as Vec3)
					))
					.catch(() => []);

				if (!pearls[0]) return;
				StasisManager.enqueue(pearls[0], mode);
			});
			logger.log(`Subscribed to ${ chalk.cyan(channel) }`);
			
		});
	}

	public static readonly proxy = new Server(this.bot);
	public static readonly chat = new ChatManager(this.bot);
	public static readonly presence = process.env.IRC_HOST ? new PresenceManager(this.bot) : null;
	public static readonly commands = new CommandManager(this.bot);
	public static readonly discord = new DiscordManager(this.bot);
	public static readonly pathfinding = new PathfindingManager(this.bot);
	public static readonly physics = new PhysicsManager(this.bot);
	public static readonly queue = new QueueManager(this.bot);
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

		// Graceful shutdown — let the bot send its disconnect packet before exiting.
		// SIGTERM (docker stop) and SIGINT (Ctrl+C) are both clean stops, so exit 0
		// so Docker does not restart the container.
		const gracefulShutdown = () => {
			this.exitCode = 0;
			Client.bot.quit();
		};
		process.once("SIGTERM", gracefulShutdown);
		process.once("SIGINT", gracefulShutdown);

	}

}
