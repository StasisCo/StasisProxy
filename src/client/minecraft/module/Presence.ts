import { zIrcPresence } from "@hackware/types/schema/irc/payload/zIrcPresence";
import { zIrcPayload } from "@hackware/types/schema/irc/zIrcPayload";
import chalk from "chalk";
import EventEmitter from "events";
import { EventSource } from "eventsource";
import type { Item } from "prismarine-item";
import z from "zod";
import { Logger } from "~/class/Logger";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";
import { ChatManager, chatCommandsConfig } from "~/client/minecraft/manager/ChatManager";
import { name, version } from "../../../../package.json";
import { normalizeUUID } from "~/utils";
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";

/**
 * The `meta` SSE event that precedes every delivered payload, naming the
 * authoritative sender. Chat and direct messages carry no sender of their own —
 * this is the only place the speaker's identity comes from.
 */
const zIrcMeta = z.object({
	userAgent: z.string().nullish(),
	authoritativeSender: z.object({
		id: z.string(),
		username: z.string()
	}).nullish()
});

export type IrcMeta = z.infer<typeof zIrcMeta>;

const zConfigSchema = z.object({
	maxRate: z
		.number()
		.default(5)
		.describe("Maximum presence posts per second"),
	maxInterval: z
		.number()
		.default(5)
		.describe("Maximum seconds between presence posts (heartbeat)"),
	heartbeatTimeout: z
		.number()
		.default(15_000)
		.describe("Force-reconnect if no SSE bytes arrive within this many ms"),
	maxReconnectDelay: z
		.number()
		.default(30_000)
		.describe("Cap on backoff between SSE reconnect attempts (ms)")
});

export default class Presence extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	private static readonly logger = new Logger(chalk.hex("#55FFFF")("IRC"));

	/**
	 * Public event bus for IRC payloads — subscribe with
	 * `Module.get<Presence>("Presence").events.on(...)`. Payload events carry
	 * the `meta` frame that preceded the payload as their second argument; it
	 * names the authoritative sender, which the payloads themselves no longer do.
	 */
	public readonly events = new EventEmitter<{
		"connected": []
		"chat": [ z.infer<typeof zIrcPayload> & { type: "chat" }, IrcMeta | null ]
		"death": [ z.infer<typeof zIrcPayload> & { type: "death" }, IrcMeta | null ]
		"login": [ z.infer<typeof zIrcPayload> & { type: "login" }, IrcMeta | null ]
		"logout": [ z.infer<typeof zIrcPayload> & { type: "logout" }, IrcMeta | null ]
		"message": [ z.infer<typeof zIrcPayload> & { type: "message" }, IrcMeta | null ]
		"ping": [ z.infer<typeof zIrcPayload> & { type: "ping" }, IrcMeta | null ]
		"presence": [ z.infer<typeof zIrcPayload> & { type: "presence" }, IrcMeta | null ]
		"resend_request": [ z.infer<typeof zIrcPayload> & { type: "resend_request" }, IrcMeta | null ]
	}>();

	private connected = false;
	private es: EventSource | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private intervalTimer: NodeJS.Timeout | null = null;
	private pending: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private refreshingToken = false;
	private lastPost = 0;

	/** Default attributes for the IRC presence */
	private attributes: z.infer<typeof zIrcPresence>["attributes"] = {
		health: 20,
		hunger: 20,
		absorption: 0,
		saturation: 5,
		oxygen: 300
	};

	/** The meta frame's sender, unless it is the bot's own echo (its chat replies
	 *  come back on the stream, and handling them would loop). */
	private senderOf(meta: IrcMeta | null): { id: string, username: string } | null {
		const sender = meta?.authoritativeSender;
		if (!sender) return null;
		const botId = MinecraftClient.bot.player?.uuid;
		if (botId && normalizeUUID(sender.id) === normalizeUUID(botId)) return null;
		return sender;
	}

	// Bound references so we can remove them on subsequent onReady calls

	private onIrcChat = async(payload: z.infer<typeof zIrcPayload> & { type: "chat" }, meta: IrcMeta | null) => {

		const sender = this.senderOf(meta);
		const message = new ChatManager.parser(<string>payload.message);
		Presence.logger.log(`${ chalk.gray("[") }${ sender?.username ?? "?" }${ chalk.gray("]") }`, message.toAnsi());
		if (!sender) return;

		// Ignore messages that don't start with the command prefix
		if (!message.toString().toLowerCase().startsWith(chatCommandsConfig.prefix.toLowerCase())) return;

		const command = message.toString().slice(chatCommandsConfig.prefix.length).trim();
		await ChatCommandManager.handle(sender.username, command, "irc");

	};

	private onIrcDirectMessage = async(payload: z.infer<typeof zIrcPayload> & { type: "message" }, meta: IrcMeta | null) => {

		const sender = this.senderOf(meta);
		const message = new ChatManager.parser(<string>payload.message);
		Presence.logger.log(`${ chalk.gray("[") }${ sender?.username ?? "?" }${ chalk.gray(" → me]") }`, message.toAnsi());
		if (!sender) return;

		// A DM is addressed to the bot by construction, so the prefix is
		// optional — but tolerated, so "!pearls" and "pearls" both work.
		const text = message.toString().trim();
		const command = text.toLowerCase().startsWith(chatCommandsConfig.prefix.toLowerCase())
			? text.slice(chatCommandsConfig.prefix.length).trim()
			: text;
		await ChatCommandManager.handle(sender.username, command, "dm");

	};

	constructor() {
		super("Presence");
	}

	public override onReady() {

		// Skip silently if IRC is not configured (don't persist to config)
		if (!process.env.IRC_HOST) return;

		// Post when inventory changes
		MinecraftClient.bot.inventory.on("updateSlot", () => this.requestPost());

		// Ensure we post at least every maxInterval seconds
		if (this.intervalTimer) clearInterval(this.intervalTimer);
		this.intervalTimer = setInterval(() => this.requestPost(), this.config.maxInterval * 1000);

		// Wire up IRC chat command handling (remove first to avoid duplicates on rebind)
		this.events.off("chat", this.onIrcChat);
		this.events.on("chat", this.onIrcChat);
		this.events.off("message", this.onIrcDirectMessage);
		this.events.on("message", this.onIrcDirectMessage);

		this.tryConnect();

	}

	public override onDisable() {
		if (this.es) {
			this.es.close();
			this.es = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		this.connected = false;
	}

	public override onPacketReceive({ name, data }: Packets.PacketEvent) {
		switch (name) {

			case "update_health":
				this.attributes.health = data.health;
				this.attributes.hunger = data.food;
				this.attributes.saturation = data.foodSaturation;
				this.requestPost();
				break;

			case "entity_metadata":
				if (data.entityId !== MinecraftClient.bot.entity?.id) break;
				for (const entry of data.metadata) {
					if (entry.key === 15) {
						this.attributes.absorption = entry.value as number;
						this.requestPost();
						break;
					}
				}
				break;

			case "respawn":
				this.attributes.oxygen = 300;
				this.requestPost();
				break;

		}
	}

	/**
	 * Translate a mineflayer Item object into the format expected by the IRC presence
	 * @param item The mineflayer Item object to translate
	 * @returns The translated item in the format expected by the IRC presence
	 */
	private static translateItem(item: Item): z.infer<typeof zIrcPresence>["inventory"][number]["item"] {
		const enchantments: z.infer<typeof zIrcPresence>["inventory"][number]["item"]["enchantments"] = [];
		if (typeof item.nbt === "object" && item.nbt && typeof item.nbt.value === "object" && item.nbt.value && "Enchantments" in item.nbt.value) {
			const enchList = item.nbt.value.Enchantments;
			if (enchList && enchList.type === "list" && enchList.value.type === "compound" && enchList.value.value) {
				for (const ench of enchList.value.value) {
					if (ench && typeof ench === "object" && "id" in ench && "lvl" in ench && ench.id && ench.lvl && ench.id.type === "string" && ench.lvl.type === "short") {
						enchantments.push({
							id: `minecraft:${ ench.id.value }`,
							level: ench.lvl.value
						});
					}
				}
			}
		}
		return {
			id: `minecraft:${ item.name }`,
			count: item.count,
			damage: item.durabilityUsed || undefined,
			maxDamage: item.maxDurability,
			name: item.displayName,
			enchantments
		};
	}

	/**
	 * Gather the current presence data for the bot, including health, hunger, absorption, saturation, oxygen, and inventory,
	 * @returns The current presence data formatted according to the zIrcPresence schema
	 */
	public get presence(): z.infer<typeof zIrcPresence> {
		const inventory = new Map<number, z.infer<typeof zIrcPresence>["inventory"][number]["item"]>();

		// Armor (mineflayer 5-8 → vanilla 39-36)
		const armorMap = [ [ 5, 39 ], [ 6, 38 ], [ 7, 37 ], [ 8, 36 ] ] as const;
		for (const [ mfSlot, vanillaSlot ] of armorMap) {
			const item = MinecraftClient.bot.inventory.slots[mfSlot];
			if (item) inventory.set(vanillaSlot, Presence.translateItem(item));
		}

		// Offhand (mineflayer 45 → vanilla 40)
		const offHand = MinecraftClient.bot.inventory.slots[45];
		if (offHand) inventory.set(40, Presence.translateItem(offHand));

		// Main inventory (mineflayer 9-35 → vanilla 9-35, same numbering)
		for (let slot = 9; slot <= 35; slot++) {
			const item = MinecraftClient.bot.inventory.slots[slot];
			if (item) inventory.set(slot, Presence.translateItem(item));
		}

		// Hotbar (mineflayer 36-44 → vanilla 0-8)
		for (let slot = 36; slot <= 44; slot++) {
			const item = MinecraftClient.bot.inventory.slots[slot];
			if (item) inventory.set(slot - 36, Presence.translateItem(item));
		}

		return zIrcPresence.parse({
			type: "presence",
			attributes: this.attributes,
			player: MinecraftClient.bot.player.uuid,
			inventory: Array.from(inventory.entries()).map(([ slot, item ]) => ({ slot, item }))
		});
	}

	private get headers() {
		return {
			"X-IRC-Multiplayer-Server": `${ MinecraftClient.host }`,
			"X-Hackware-Client-ID": `${ process.env.IRC_CLIENT_ID }`,
			"X-Hackware-Client-Secret": `${ process.env.IRC_CLIENT_SECRET }`,
			"User-Agent": MinecraftClient.options.brand || `${ name }/${ version }`,
			"Authorization": `Bearer ${ MinecraftClient.session!.accessToken }`
		};
	}

	/**
	 * Refresh the Minecraft access token via prismarine-auth without reconnecting to the MC server.
	 * Updates `MinecraftClient.session.accessToken` in place so subsequent requests use the new token.
	 */
	private async refreshToken(): Promise<boolean> {
		if (this.refreshingToken) return false;
		this.refreshingToken = true;

		try {
			const authflow = (MinecraftClient.bot._client as unknown as { authflow?: { getMinecraftJavaToken(opts: { fetchProfile: boolean }): Promise<{ token: string }> } }).authflow;
			if (!authflow) {
				Presence.logger.warn("Cannot refresh token: authflow not available");
				return false;
			}

			Presence.logger.log("Refreshing Minecraft access token...");
			const { token } = await authflow.getMinecraftJavaToken({ fetchProfile: true });

			if (MinecraftClient.session) {
				MinecraftClient.session.accessToken = token;
				Presence.logger.log("Access token refreshed successfully");
				return true;
			}

			return false;
		} catch (err) {
			Presence.logger.error("Failed to refresh access token:", err);
			return false;
		} finally {
			this.refreshingToken = false;
		}
	}

	// ── SSE connection ──

	private tryConnect() {
		if (!this.es && MinecraftClient.session && MinecraftClient.host) this.connect();
	}

	private resetHeartbeat() {
		if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
		this.heartbeatTimer = setTimeout(() => {
			Presence.logger.warn(`IRC SSE stream stalled (no data for ${ this.config.heartbeatTimeout / 1000 }s), forcing reconnect`);
			this.connected = false;
			this.connect();
		}, this.config.heartbeatTimeout);
	}

	private scheduleReconnect() {
		if (this.reconnectTimer) return;
		const delay = Math.min(
			this.config.maxReconnectDelay,
			1000 * Math.pow(2, this.reconnectAttempts++)
		);
		Presence.logger.log(`Retrying IRC SSE in ${ delay }ms (attempt ${ this.reconnectAttempts })`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private connect() {

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.heartbeatTimer) {
			clearTimeout(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.es) {
			this.es.close();
			this.es = null;
		}

		if (!MinecraftClient.session || !MinecraftClient.host) return;

		const url = new URL("/irc", process.env.IRC_HOST).href;

		Presence.logger.log(`Connecting to IRC SSE stream: ${ chalk.cyan.underline(url) }...`);

		const es = new EventSource(url, {
			fetch: async(input, init) => {
				let res = await fetch(input, {
					...init,
					headers: {
						...init.headers,
						...this.headers,
						"Accept": "text/event-stream",
						"Cache-Control": "no-cache"
					}
				});

				if (res.status === 401) {
					Presence.logger.warn("IRC returned 401, refreshing access token...");
					const refreshed = await this.refreshToken();

					if (refreshed) {
						res = await fetch(input, {
							...init,
							headers: {
								...init.headers,
								...this.headers,
								"Accept": "text/event-stream",
								"Cache-Control": "no-cache"
							}
						});
					}
				}

				const contentType = res.headers.get("content-type") ?? "(none)";
				if (!res.ok || !contentType.includes("text/event-stream")) {
					const body = await res.clone().text().catch(() => "(unreadable)");
					Presence.logger.warn(`IRC SSE fetch: ${ res.status } ${ res.statusText } | content-type: ${ contentType } | body: ${ body }`);
				}

				return res;
			}
		});

		this.es = es;
		this.resetHeartbeat();

		es.onopen = () => {
			this.reconnectAttempts = 0;
			if (!this.connected) {
				Presence.logger.log("Connected to IRC SSE stream");
				this.connected = true;
			}
			this.resetHeartbeat();
			this.requestPost();
			this.events.emit("connected");
		};

		// Every payload is preceded by a named `meta` event carrying the
		// authoritative sender. SSE guarantees ordering, so holding the last
		// meta until the next unnamed message pairs the two; the pending value
		// is cleared on consumption so a meta can never attach to more than
		// one payload.
		let pendingMeta: IrcMeta | null = null;
		es.addEventListener("meta", ({ data }) => {
			this.resetHeartbeat();
			pendingMeta = null;
			if (!data || typeof data !== "string") return;
			try {
				const parsed = zIrcMeta.safeParse(JSON.parse(data));
				if (parsed.success) pendingMeta = parsed.data;
			} catch {}
		});

		es.onmessage = ({ data }) => {
			this.resetHeartbeat();
			const meta = pendingMeta;
			pendingMeta = null;
			if (!data || typeof data !== "string") return;

			let json: unknown;
			try {
				json = JSON.parse(data);
			} catch {
				return;
			}

			const parsed = zIrcPayload.safeParse(json);
			if (!parsed.success) return;

			const payload = parsed.data;
			this.events.emit(payload.type, payload as never, meta as never);
		};

		es.onerror = event => {
			if (this.es !== es) return;
			this.scheduleReconnect();
			Presence.logger.warn(event, es);
		};
	}

	/**
	 * POST an arbitrary JSON body to the IRC endpoint.
	 *
	 * The body is sent verbatim — no schema is applied — so this can carry any payload type the
	 * IRC server accepts. Auth headers, the endpoint and the 401-refresh-retry are shared with
	 * every other request the module makes.
	 *
	 * @param body Any JSON-serialisable value
	 * @returns the response, or null if the request could not be made at all
	 */
	public async post(body: z.infer<typeof zIrcPayload> | Array<z.infer<typeof zIrcPayload>>): Promise<Response | null> {
		if (!MinecraftClient.session || !MinecraftClient.host || !MinecraftClient.bot.player) return null;

		const send = () => fetch(new URL("/irc", process.env.IRC_HOST), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.headers
			},
			body: JSON.stringify(body)
		});

		try {
			const res = await send();

			// The access token can expire mid-session; the SSE stream already recovers from this,
			// so posts should too rather than silently dropping until the next reconnect.
			if (res.status === 401 && await this.refreshToken()) return await send();

			return res;
		} catch {

			// Connection error — presence posts retry on the next interval, and one-off payloads
			// are the caller's to re-send if they care.
			return null;
		}
	}

	/**
	 * POST a presence payload.
	 * @param body The presence to send
	 */
	public async postPresence(body: z.infer<typeof zIrcPresence>) {
		await this.post(body);
	}

	/**
	 * POST a broadcast chat line. The sender is implied by the credentials —
	 * chat payloads carry no player.
	 * @param message The line to say, as a plain string
	 */
	public async postChat(message: string) {
		await this.post({ type: "chat", message });
	}

	/** Request a presence post — rate-limited to config.maxRate per second */
	private requestPost() {
		if (this.pending) return;

		const minGap = 1000 / this.config.maxRate;
		const elapsed = Date.now() - this.lastPost;
		const delay = Math.max(0, minGap - elapsed);

		this.pending = setTimeout(() => {
			this.pending = null;
			this.lastPost = Date.now();
			if (MinecraftClient.bot.player) this.postPresence(this.presence);
		}, delay);
	}

}
