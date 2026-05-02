import chalk from "chalk";
import { createServer, type Server as MinecraftServer, type SessionObject } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import type { ChatMessage } from "prismarine-chat";
import sharp from "sharp";
import z from "zod";
import { Client } from "~/class/Client";
import { Logger } from "~/class/Logger";
import { ChatManager } from "~/manager/ChatManager";
import { Stasis } from "../Stasis";
import { PacketCache } from "./PacketCache";
import { PlayerListCache } from "./PlayerListCache";
import { ServerClient } from "./ServerClient";

/**
 * The proxy server: a Minecraft listener that lets a single human player take
 * control of the bot's connection by replaying the upstream world state. Owns
 * the {@link PacketCache} and {@link PlayerListCache} that record the upstream
 * state, and instantiates a fresh {@link ServerClient} per connection.
 *
 * The dynamic MOTD cycles through queue status, online count, and pearl stats.
 *
 * @example
 * Client.proxy = new Server(bot);
 * // ... later
 * await Client.proxy.close();
 */
export class Server {

	public static readonly logger = new Logger(chalk.blue("PROXY"));

	/** Records the upstream world state for replay on player join. */
	public readonly packetCache: PacketCache;

	/** Tracks the upstream player list for warm-starting new clients. */
	public readonly playerListCache: PlayerListCache;

	private server: MinecraftServer | null = null;

	/** Cached favicon data URL, applied to the server when both are ready. */
	private favicon: string | null = null;

	/** The bot's signed skin texture properties, captured from upstream login_success. */
	private botProperties: Array<{ name: string; value: string; signature?: string }> = [];

	/** The single connected proxy player, if any. */
	private current: ServerClient | null = null;

	/**
	 * Build a new proxy server bound to the given mineflayer bot. Starts
	 * recording packets immediately; the actual TCP listener is started once
	 * the bot's `game` event fires.
	 */
	constructor(private readonly bot: Mineflayer) {
		this.packetCache = new PacketCache(bot);
		this.playerListCache = new PlayerListCache(bot);

		this.startFaviconFetch();
		this.captureBotProperties();

		if (bot.game) this.startServer();
		else bot.once("game", () => this.startServer());
	}

	/** Whether a player is currently controlling the bot. */
	public get connected(): boolean {
		return this.current !== null;
	}

	/** Dynamic MOTD shown on server-list pings. Cycles through proxy status info. */
	public get motd(): string {
		const CYCLE_DUR = 3000;

		const HEADER = "§8§l» §3§lStasisProxy §8§l«§r";
		const BODY = [ `§b§n${ Client.bot.username }` ];

		if (Client.queue.isQueued) {
			const position = Client.queue.position;
			if (position !== null) {
				BODY.push(`§6Position in queue: §e${ position }`);
			} else {
				const title = (Client.queue.title || Client.queue.subtitle)?.toMotd();
				BODY.push(title || "§6Waiting for position...");
			}
		} else {
			if (Date.now() % CYCLE_DUR * 2 >= CYCLE_DUR) {
				BODY.push(`§6${ Client.host }`);
				BODY.push(`§e${ Object.entries(Client.bot.players).length } Online`);
			} else {
				BODY.push(`§d${ Stasis.instances.size } Pearls`);
				const unique = Stasis.instances.values()
					.filter(p => p.ownerId !== undefined)
					.map(p => p.ownerId!)
					.reduce((set, ownerId) => set.add(ownerId), new Set<string>()).size;
				BODY.push(`§a${ unique } Players`);
			}
		}

		return [ HEADER, BODY.join("§r — ") ].map(line => ChatManager.center(line, 270)).filter(Boolean).join("\n");
	}

	/** Shut down the proxy server and detach all caches. */
	public close() {
		this.packetCache.close();
		this.playerListCache.close();
		this.current?.detach();
		this.current?.client.end("Proxy server shutting down.");
		this.server?.close();
	}

	// ─────────────────────────────── internals ───────────────────────────────

	private startServer() {
		const port = parseInt(z.string().optional().parse(process.env.PROXY_PORT) ?? Math.floor(10000 + Math.random() * 50000).toString(), 10);

		this.server = createServer({
			port,
			"online-mode": true,
			version: this.bot.version,
			motd: this.motd,
			maxPlayers: 1,
			keepAlive: false,
			errorHandler: (_client, err) => {
				Server.logger.warn(`Protocol error: ${ err.message }`);
			},
			beforeLogin: client => {
				Server.logger.log(`UUID of player ${ client.username } is ${ client.uuid }`);

				// Make the connecting player appear as the bot: swap their UUID
				// and username in login_success so the client thinks it IS the
				// bot. The cached player_info from 2b2t already carries the
				// bot's UUID with its skin textures, so on replay the client
				// renders the bot's skin.
				const profile = this.bot._client.session?.selectedProfile;
				if (!profile) return;

				// Preserve the real username before overwriting (used for
				// disconnect logs).
				const _originalUsername = client.username;
				const rawId = profile.id.replace(/-/g, "");

				client.uuid = `${ rawId.slice(0, 8) }-${ rawId.slice(8, 12) }-${ rawId.slice(12, 16) }-${ rawId.slice(16, 20) }-${ rawId.slice(20) }`;
				client.username = profile.name;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- attaching arbitrary metadata
				(client as any)._originalUsername = _originalUsername;

				// Inject bot skin properties into login_success
				// (minecraft-protocol hardcodes properties: []).
				if (this.botProperties.length > 0) {
					const origWrite = client.write.bind(client);
					client.write = (name: string, params: Record<string, unknown>) => {
						if (name === "success") params.properties = this.botProperties;
						return origWrite(name, params);
					};
				}

				Server.logger.log(`${ _originalUsername }[/${ client.socket.remoteAddress }:${ client.socket.remotePort }] logged in with entity id ${ this.bot.player?.entity?.id ?? "?" }`);
			}
		});

		// Apply favicon if it was fetched before the server started.
		if (this.favicon) this.server.favicon = this.favicon;

		// Make motd dynamic so every server-list ping gets a fresh value.
		Object.defineProperty(this.server, "motd", {
			get: () => this.motd,
			configurable: true
		});

		this.server.on("playerJoin", client => {
			if (this.current) {
				client.end("A player is already connected.");
				return;
			}

			const sc = new ServerClient(client, this.bot, this.packetCache, this.playerListCache);
			this.current = sc;
			client.once("end", () => {
				if (this.current === sc) this.current = null;
			});
			sc.attach();
		});

		Server.logger.log("Listening on", chalk.yellow(`:${ port }`));
	}

	private startFaviconFetch() {
		const fetchFavicon = ({ selectedProfile: { id }}: SessionObject) => void fetch(`https://mc-heads.net/head/${ id }`)
			.then(res => res.arrayBuffer().then(Buffer.from))
			.then(sharp)
			.then(img => img.resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }}))
			.then(img => img.png().toBuffer())
			.then(buf => `data:image/png;base64,${ buf.toString("base64") }`)
			.then(dataUrl => {
				this.favicon = dataUrl;
				if (this.server) this.server.favicon = dataUrl;
			})
			.catch(error => Server.logger.warn("Failed to fetch player head for proxy favicon", "\n" + error.stack));

		this.bot._client.on("session", fetchFavicon);
		if (this.bot._client.session) fetchFavicon(this.bot._client.session);
	}

	private captureBotProperties() {
		this.bot._client.once("success", (packet: { properties?: Array<{ name: string; value: string; signature?: string }> }) => {
			if (Array.isArray(packet.properties)) this.botProperties = packet.properties;
		});
	}

	public kickAll(reason: ChatMessage) {
		if (!this.current) return;
		this.current.client.end(reason.toMotd());
	}

}
