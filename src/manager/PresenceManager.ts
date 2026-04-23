import { zIrcPresence } from "@hackware/types/schema/irc/payload/zIrcPresence";
import { zIrcPayload } from "@hackware/types/schema/irc/zIrcPayload";
import chalk from "chalk";
import EventEmitter from "events";
import { EventSource } from "eventsource";
import type { PacketMeta, SessionObject } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import type { Item } from "prismarine-item";
import type z from "zod";
import { Client } from "~/class/Client";
import { Logger } from "~/class/Logger";
import { COMMAND_CHAT_PREFIX } from "~/config";
import { name, version } from "../../package.json";
import { ChatManager } from "./ChatManager";
import { CommandManager } from "./CommandManager";

export class PresenceManager extends EventEmitter<{
	"death": [ z.infer<typeof zIrcPayload> & { type: "death" } ]
	"login": [ z.infer<typeof zIrcPayload> & { type: "login" } ]
	"logout": [ z.infer<typeof zIrcPayload> & { type: "logout" } ]
	"message": [ z.infer<typeof zIrcPayload> & { type: "message" } ]
	"ping": [ z.infer<typeof zIrcPayload> & { type: "ping" } ]
	"presence": [ z.infer<typeof zIrcPayload> & { type: "presence" } ]
}> {
    
	private static readonly logger = new Logger(chalk.hex("#55FFFF")("IRC"));
	
	private session?: SessionObject;
	private es: EventSource | null = null;
	private absorption = 0;
	
	/**
     * Handles incoming packets to track health, attributes, session, and host.
     */
	private readonly onPacket = (_packet: unknown, { name }: PacketMeta) => {
		const event = { name, data: _packet } as Packets.PacketEvent;
		switch (event.name) {

			case "update_health":
				this.attributes.health = event.data.health;
				this.attributes.hunger = event.data.food;
				this.attributes.saturation = event.data.foodSaturation;
				this.requestPost();
				break;

			case "entity_metadata":
				if (event.data.entityId !== this.bot.entity?.id) break;
				for (const entry of event.data.metadata) {
					if (entry.key === 15) {
						this.absorption = entry.value as number;
						this.attributes.absorption = this.absorption;
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
	};

	constructor(private readonly bot: Mineflayer) {
		super();

		// Capture session if already available
		this.session = bot._client.session ?? undefined;

		// Listen for session and connect events immediately (they fire before "game")
		const tryConnect = () => {
			if (!this.es && this.session && Client.host) this.connect();
		};

		bot._client.on("session", (session: SessionObject) => {
			this.session = session;
			tryConnect();
		});

		bot._client.on("connect", () => tryConnect());

		if (bot.game) {
			this.startListening();
		} else {
			bot.once("game", () => this.startListening());
		}

		// Log incoming IRC messages
		this.on("message", async payload => {

			const message = new ChatManager.parser(<string>payload.message);
			PresenceManager.logger.log(`${ chalk.gray("[") }${ payload.player.name }${ chalk.gray("]") }`, message.toAnsi());

			// Ignore messages that don't start with the command prefix
			if (!message.toString().toLowerCase().startsWith(COMMAND_CHAT_PREFIX.toLowerCase())) return;
			
			const command = message.toString().slice(COMMAND_CHAT_PREFIX.length).trim();
			await CommandManager.handle(payload.player.name, command, "irc");

		});
	}

	private startListening() {

		// Capture session/host now that the connection is established
		this.session ??= this.bot._client.session ?? undefined;

		this.bot._client.on("packet", this.onPacket);

		// Post when inventory changes
		this.bot.once("spawn", () => void this.bot.inventory.on("updateSlot", () => this.requestPost()));

		// Ensure we post at least every MAX_INTERVAL seconds
		setInterval(() => this.requestPost(), PresenceManager.MAX_INTERVAL * 1000);

		// Connect to SSE if not already connected (safety net if events fired before listeners)
		if (!this.es && this.session && Client.host) this.connect();

	}
	
	/**
     * Default attributes for the IRC presence
     */
	private attributes: z.infer<typeof zIrcPresence>["attributes"] = {
		health: 20,
		hunger: 20,
		absorption: 0,
		saturation: 5,
		oxygen: 300
	};
	
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
	public get(): z.infer<typeof zIrcPresence> {
		const inventory = new Map<number, z.infer<typeof zIrcPresence>["inventory"][number]["item"]>();

		// Armor (mineflayer 5-8 → vanilla 39-36)
		const armorMap = [ [ 5, 39 ], [ 6, 38 ], [ 7, 37 ], [ 8, 36 ] ] as const;
		for (const [ mfSlot, vanillaSlot ] of armorMap) {
			const item = this.bot.inventory.slots[mfSlot];
			if (item) inventory.set(vanillaSlot, PresenceManager.translateItem(item));
		}

		// Offhand (mineflayer 45 → vanilla 40)
		const offHand = this.bot.inventory.slots[45];
		if (offHand) inventory.set(40, PresenceManager.translateItem(offHand));

		// Main inventory (mineflayer 9-35 → vanilla 9-35, same numbering)
		for (let slot = 9; slot <= 35; slot++) {
			const item = this.bot.inventory.slots[slot];
			if (item) inventory.set(slot, PresenceManager.translateItem(item));
		}

		// Hotbar (mineflayer 36-44 → vanilla 0-8)
		for (let slot = 36; slot <= 44; slot++) {
			const item = this.bot.inventory.slots[slot];
			if (item) inventory.set(slot - 36, PresenceManager.translateItem(item));
		}

		return zIrcPresence.parse({
			type: "presence",
			attributes: this.attributes,
			player: {
				name: this.bot.username,
				uuid: this.bot.player.uuid
			},
			inventory: Array.from(inventory.entries()).map(([ slot, item ]) => ({ slot, item }))
		});
	}

	private headers() {
		return {
			"X-IRC-Multiplayer-Server": `${ Client.host }`,
			"User-Agent": `${ name }/${ version }`,
			"Authorization": `Bearer ${ this.session!.accessToken }`
		};
	}

	// ── SSE connection ──

	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private connected = false;

	private connect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.es) {
			try {
				this.es.close();
			} catch {

				// ignore
			}
			this.es = null;
		}

		if (!this.session || !Client.host) return;

		const es = new EventSource(new URL("/irc", process.env.IRC_HOST).href, {
			fetch: (input, init) => fetch(input, {
				...init,
				headers: {
					...(init?.headers ?? {}),
					...this.headers(),
					"Accept": "text/event-stream",
					"Cache-Control": "no-cache"
				}
			}).then(res => {
				if (!res.ok) PresenceManager.logger.warn(`IRC SSE fetch returned ${ res.status } ${ res.statusText }`);
				return res;
			})
		});
		
		this.es = es;

		es.onopen = () => {
			if (!this.connected) {
				PresenceManager.logger.log("Connected to IRC SSE stream");
				this.connected = true;
			}
			this.requestPost();
		};

		es.onmessage = ({ data }) => {
			if (!data || typeof data !== "string") return;

			let json: unknown;
			try { json = JSON.parse(data); }
			catch { return; }

			const parsed = zIrcPayload.safeParse(json);
			if (!parsed.success) return;

			const payload = parsed.data;
			this.emit(payload.type, payload as never);
		};

		es.onerror = (event) => {
			const detail = "message" in event ? (event as { message: string }).message : "";
			if (es.readyState === EventSource.CLOSED) {
				PresenceManager.logger.warn(`IRC SSE stream closed${ detail ? `: ${ detail }` : "" }, reconnecting in 5s...`);
				this.connected = false;
				this.reconnectTimer = setTimeout(() => {
					this.reconnectTimer = null;
					this.connect();
				}, 5000);
			}
			// CONNECTING state = normal SSE auto-reconnect, no log needed
		};
	}

	public async post(body: z.infer<typeof zIrcPresence>) {
		if (!this.session || !Client.host || !this.bot.player) return;

		try {
			await fetch(new URL("/irc", process.env.IRC_HOST), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...this.headers()
				},
				body: JSON.stringify(body)
			});
		} catch { /* connection error, will retry on next interval */ }
	}

	/** Maximum posts per second */
	private static readonly MAX_RATE = 5;

	/** Maximum seconds between posts */
	private static readonly MAX_INTERVAL = 5;

	/** Minimum ms between posts (1000 / MAX_RATE) */
	private static readonly MIN_GAP = 1000 / PresenceManager.MAX_RATE;

	/** Timestamp of the last successful post */
	private lastPost = 0;

	/** Pending post timeout handle */
	private pending: ReturnType<typeof setTimeout> | null = null;

	/** Request a presence post — rate-limited to MAX_RATE per second */
	private requestPost() {
		if (this.pending) return;

		const elapsed = Date.now() - this.lastPost;
		const delay = Math.max(0, PresenceManager.MIN_GAP - elapsed);

		this.pending = setTimeout(() => {
			this.pending = null;
			this.lastPost = Date.now();
			if (this.bot.player) this.post(this.get());
		}, delay);
	}

}