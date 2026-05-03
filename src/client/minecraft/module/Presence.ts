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
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";

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

	/** Public event bus for IRC payloads — subscribe with `Module.get<Presence>("Presence").events.on(...)` */
	public readonly events = new EventEmitter<{
		"death": [ z.infer<typeof zIrcPayload> & { type: "death" } ]
		"login": [ z.infer<typeof zIrcPayload> & { type: "login" } ]
		"logout": [ z.infer<typeof zIrcPayload> & { type: "logout" } ]
		"message": [ z.infer<typeof zIrcPayload> & { type: "message" } ]
		"ping": [ z.infer<typeof zIrcPayload> & { type: "ping" } ]
		"presence": [ z.infer<typeof zIrcPayload> & { type: "presence" } ]
	}>();

	private connected = false;
	private es: EventSource | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private intervalTimer: NodeJS.Timeout | null = null;
	private pending: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private lastPost = 0;

	/** Default attributes for the IRC presence */
	private attributes: z.infer<typeof zIrcPresence>["attributes"] = {
		health: 20,
		hunger: 20,
		absorption: 0,
		saturation: 5,
		oxygen: 300
	};

	// Bound reference so we can remove it on subsequent onReady calls
	private onIrcMessage = async(payload: z.infer<typeof zIrcPayload> & { type: "message" }) => {

		const message = new ChatManager.parser(<string>payload.message);
		Presence.logger.log(`${ chalk.gray("[") }${ payload.player.name }${ chalk.gray("]") }`, message.toAnsi());

		// Ignore messages that don't start with the command prefix
		if (!message.toString().toLowerCase().startsWith(chatCommandsConfig.prefix.toLowerCase())) return;

		const command = message.toString().slice(chatCommandsConfig.prefix.length).trim();
		await ChatCommandManager.handle(payload.player.name, command, "irc");

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
		this.events.off("message", this.onIrcMessage);
		this.events.on("message", this.onIrcMessage);

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
			player: {
				name: MinecraftClient.bot.username,
				uuid: MinecraftClient.bot.player.uuid
			},
			inventory: Array.from(inventory.entries()).map(([ slot, item ]) => ({ slot, item }))
		});
	}

	private get headers() {
		return {
			"X-IRC-Multiplayer-Server": `${ MinecraftClient.host }`,
			"User-Agent": MinecraftClient.options.brand || `${ name }/${ version }`,
			"Authorization": `Bearer ${ MinecraftClient.session!.accessToken }`
		};
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
			fetch: (input, init) => fetch(input, {
				...init,
				headers: {
					...init.headers,
					...this.headers,
					"Accept": "text/event-stream",
					"Cache-Control": "no-cache"
				}
			}).then(res => {
				if (!res.ok) Presence.logger.warn(`IRC SSE fetch returned ${ res.status } ${ res.statusText }`);
				return res;
			})
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
		};

		es.onmessage = ({ data }) => {
			this.resetHeartbeat();
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
			this.events.emit(payload.type, payload as never);
		};

		es.onerror = event => {
			if (this.es !== es) return;
			this.scheduleReconnect();
			Presence.logger.warn(event);
		};
	}

	public async post(body: z.infer<typeof zIrcPresence>) {
		if (!MinecraftClient.session || !MinecraftClient.host || !MinecraftClient.bot.player) return;

		try {
			await fetch(new URL("/irc", process.env.IRC_HOST), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...this.headers
				},
				body: JSON.stringify(body)
			});
		} catch { /* connection error, will retry on next interval */ }
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
			if (MinecraftClient.bot.player) this.post(this.presence);
		}, delay);
	}

}
