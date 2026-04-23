import chalk from "chalk";
import crypto from "crypto";
import { createServer, type Client as MinecraftClient, type PacketMeta, type Server, type SessionObject } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import sharp from "sharp";
import { Vec3 } from "vec3";
import z from "zod";
import { StasisColumn } from "~/class/StasisColumn";
import { ChatManager } from "~/manager/ChatManager";
import { prisma } from "~/prisma";
import { Logger } from "../util/Logger";
import { Client } from "./Client";

/**
 * Cached packet entry with insertion order preserved via the sequence number.
 */
interface CachedPacket {
	seq: number;
	name: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	data: any;

	/** Raw packet buffer for writeRaw replay (avoids re-serialization issues). */
	buffer: Buffer;
}

/**
 * Defines how a packet is keyed in the cache. 
 * - A string key function means the packet is "keyed" — only the latest value per key is kept.
 * - `true` means the packet is stored once (singleton).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- packet shapes are dynamic
const PACKET_KEYS: Record<string, true | ((data: any) => string)> = {

	// ── Login & Configuration (singletons — one value each) ──
	"login": true,
	"difficulty": true,
	"abilities": true,
	"held_item_slot": true,
	"declare_commands": true,
	"declare_recipes": true,
	"unlock_recipes": true,
	"tags": true,
	"feature_flags": true,
	"server_data": true,
	"spawn_position": true,
	"update_time": true,
	"update_health": true,
	"experience": true,
	"position": true,
	"update_view_position": true,
	"simulation_distance": true,
	"update_view_distance": true,
	"playerlist_header": true,
	"initialize_world_border": true,
	"world_border_center": true,
	"world_border_size": true,

	// ── Title / Action bar (singletons — latest value only) ──
	"set_title_text": true,
	"set_title_subtitle": true,
	"set_title_time": true,
	"action_bar": true,

	// ── Keyed by entity ID ──
	"spawn_entity": d => `${ d.entityId }`,
	"named_entity_spawn": d => `${ d.entityId }`,
	"spawn_entity_experience_orb": d => `${ d.entityId }`,
	"entity_metadata": d => `${ d.entityId }`,
	"entity_equipment": d => `${ d.entityId }`,
	"entity_update_attributes": d => `${ d.entityId }`,
	"entity_head_rotation": d => `${ d.entityId }`,
	"entity_teleport": d => `${ d.entityId }`,
	"set_passengers": d => `${ d.entityId }`,
	"entity_effect": d => `${ d.entityId }:${ d.effectId }`,

	// ── Keyed by chunk coordinate ──
	"map_chunk": d => `${ d.x },${ d.z }`,
	"update_light": d => `${ d.chunkX },${ d.chunkZ }`,

	// ── Keyed by block position ──
	"block_change": d => `${ d.location.x },${ d.location.y },${ d.location.z }`,
	"tile_entity_data": d => `${ d.location.x },${ d.location.y },${ d.location.z }`,

	// ── Keyed by chunk section ──
	"multi_block_change": d => `${ d.chunkCoordinates.x },${ d.chunkCoordinates.y },${ d.chunkCoordinates.z }`,

	// ── Keyed by scoreboard identifiers ──
	"scoreboard_objective": d => `${ d.name }`,
	"scoreboard_display_objective": d => `${ d.position }`,
	"scoreboard_score": d => `${ d.itemName }:${ d.scoreName }`,
	"teams": d => `${ d.team }`,

	// ── Keyed by window ──
	"window_items": d => `${ d.windowId }`,
	"set_slot": d => `${ d.windowId }:${ d.slot }`,

	// ── Keyed by boss bar UUID ──
	"boss_bar": d => `${ d.entityUUID }`,

	// ── Game state changes keyed by reason ──
	"game_state_change": d => `${ d.reason }`,

	// ── Player list (replace whole list each time) ──
	"player_info": true
};

/**
 * Entity-related packet names that should be deleted when an entity is destroyed.
 */
const ENTITY_PACKET_NAMES = [
	"spawn_entity",
	"named_entity_spawn",
	"spawn_entity_experience_orb",
	"entity_metadata",
	"entity_equipment",
	"entity_update_attributes",
	"entity_head_rotation",
	"entity_teleport",
	"set_passengers"
] as const;

export class Proxy {

	private static readonly logger = new Logger(chalk.green("PROXY"));

	/**
	 * Packets that must be re-serialized via write() instead of writeRaw().
	 * ViaVersion on 2b2t can produce wire bytes with extra data that the
	 * vanilla client rejects — re-serializing from the parsed data fixes this.
	 */
	private static readonly RESERIALIZE_PACKETS = new Set([ "entity_equipment" ]);

	private server!: Server;

	/**
	 * The packet cache. Outer map is keyed by packet name, inner map is keyed by
	 * the packet's unique key (or "_" for singletons).
	 */
	private readonly cache = new Map<string, Map<string, CachedPacket>>();

	/** Monotonically increasing counter to preserve insertion/update order. */
	private seq = 0;

	/** Cached favicon data URL, applied to server when both are ready */
	private favicon: string | null = null;

	/** The currently connected player client, if any */
	private client: MinecraftClient | null = null;

	// ── Stasis hologram tracking ──

	/** Next fake entity ID for client-side armor stands (high range to avoid real entity collisions) */
	private nextFakeEntityId = 0x70000000;

	/** Map from stasis key (dim:x:y:z) to fake entity ID */
	private readonly holograms = new Map<string, number>();

	private static hologramKey(dimension: string, x: number, y: number, z: number) {
		return `${ dimension }:${ x }:${ y }:${ z }`;
	}

	constructor(private readonly bot: Mineflayer) {

		// Start recording packets immediately (before game is ready)
		bot._client.on("packet", this.onPacket);

		// Download favicon as soon as session is available
		const fetchFavicon = ({ selectedProfile: { id }}: SessionObject) => void fetch(`https://mc-heads.net/head/${ id }/64`)
			.then(res => res.arrayBuffer().then(Buffer.from))
			.then(sharp)
			.then(img => img.resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }}))
			.then(img => img.png().toBuffer())
			.then(buf => `data:image/png;base64,${ buf.toString("base64") }`)
			.then(dataUrl => {
				this.favicon = dataUrl;
				if (this.server) this.server.favicon = dataUrl;
			})
			.catch(error => Proxy.logger.warn("Failed to fetch player head for proxy favicon", "\n" + error.stack));

		bot._client.on("session", fetchFavicon);
		if (bot._client.session) fetchFavicon(bot._client.session);

		if (bot.game) {
			this.startServer();
		} else {
			bot.once("game", () => this.startServer());
		}
	}

	get motd(): string {
		const lines = [ "§8§l» §3§lStasisProxy §8§l«§r" ];
		
		if (Client.queue.queued) lines.push(`§b§n${ Client.bot.username }§r - ${ (Client.queue.subtitle || Client.queue.title)?.toMotd() || "§6Queueing..." }`);
		else lines.push(`§b§n${ Client.bot.username }§r - §e${ Object.keys(Client.bot.players).length } Online`);

		return lines.filter(Boolean).map(line => ChatManager.center(line, 270)).join("\n");
	}

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
				Proxy.logger.warn(`Protocol error: ${ err.message }`);
			}
		});

		// Apply favicon if it was fetched before the server started
		if (this.favicon) this.server.favicon = this.favicon;

		// Make motd dynamic so every server list ping gets a fresh value
		Object.defineProperty(this.server, "motd", {
			get: () => this.motd,
			configurable: true
		});

		this.server.on("playerJoin", client => this.onPlayerJoin(client));
		Proxy.logger.log("Listening on", chalk.yellow(`:${ port }`));
	}

	// ── Cache helpers ──

	private set(name: string, key: string, data: unknown, buffer: Buffer) {
		let inner = this.cache.get(name);
		if (!inner) {
			inner = new Map();
			this.cache.set(name, inner);
		}

		// Deep-copy the data — parsed objects may contain views into the protocol
		// stream's internal pool whose memory can be reused after the event handler.
		// Copy the raw buffer too — used for writeRaw replay to avoid re-serialization
		// issues (structuredClone converts Buffers to Uint8Array, corrupting chunk data).
		inner.set(key, { seq: this.seq++, name, data: structuredClone(data), buffer: Buffer.from(buffer) });
	}

	private deleteKey(name: string, key: string) {
		this.cache.get(name)?.delete(key);
	}

	private deleteAll(name: string) {
		this.cache.delete(name);
	}

	private deleteEntity(entityId: number) {
		const key = `${ entityId }`;
		for (const name of ENTITY_PACKET_NAMES) {
			this.deleteKey(name, key);
		}

		// Also remove entity effects (keyed as entityId:effectId)
		const effectMap = this.cache.get("entity_effect");
		if (effectMap) {
			for (const k of effectMap.keys()) {
				if (k.startsWith(`${ entityId }:`)) effectMap.delete(k);
			}
		}
	}

	/**
	 * Remove stale block_change, multi_block_change, and tile_entity_data entries
	 * that fall within the given chunk column.
	 */
	private invalidateBlocksInChunk(chunkX: number, chunkZ: number) {
		for (const pktName of [ "block_change", "tile_entity_data" ] as const) {
			const map = this.cache.get(pktName);
			if (!map) continue;
			for (const key of map.keys()) {
				const parts = key.split(",").map(Number);
				if ((parts[0]! >> 4) === chunkX && (parts[2]! >> 4) === chunkZ) map.delete(key);
			}
		}

		const mbc = this.cache.get("multi_block_change");
		if (mbc) {
			for (const key of mbc.keys()) {
				const parts = key.split(",").map(Number);
				if (parts[0] === chunkX && parts[2] === chunkZ) mbc.delete(key);
			}
		}
	}

	// ── Packet handler ──

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	private readonly onPacket = (data: any, meta: PacketMeta, buffer: Buffer) => {
		const { name } = meta;

		// ── Invalidation: entity destroyed ──
		if (name === "entity_destroy") {
			if (Array.isArray(data.entityIds)) {
				for (const id of data.entityIds) this.deleteEntity(id);
			}
			return;
		}

		// ── Invalidation: chunk unloaded ──
		if (name === "unload_chunk") {
			const chunkKey = `${ data.chunkX },${ data.chunkZ }`;
			this.deleteKey("map_chunk", chunkKey);
			this.deleteKey("update_light", chunkKey);
			this.invalidateBlocksInChunk(data.chunkX, data.chunkZ);
			return;
		}

		// ── Invalidation: respawn (dimension change) — clear all world state ──
		if (name === "respawn") {
			for (const pktName of ENTITY_PACKET_NAMES) this.deleteAll(pktName);
			this.deleteAll("entity_effect");
			this.deleteAll("map_chunk");
			this.deleteAll("update_light");
			this.deleteAll("scoreboard_objective");
			this.deleteAll("scoreboard_display_objective");
			this.deleteAll("scoreboard_score");
			this.deleteAll("teams");
			this.deleteAll("boss_bar");
			this.deleteAll("window_items");
			this.deleteAll("set_slot");
			this.deleteAll("block_change");
			this.deleteAll("multi_block_change");
			this.deleteAll("tile_entity_data");
			this.deleteAll("initialize_world_border");
			this.deleteAll("world_border_center");
			this.deleteAll("world_border_size");
			this.deleteAll("position");
			this.deleteAll("update_health");
			this.deleteAll("experience");
			this.deleteAll("update_view_position");
			this.deleteAll("game_state_change");
			this.deleteAll("spawn_position");
			this.deleteAll("set_title_text");
			this.deleteAll("set_title_subtitle");
			this.deleteAll("set_title_time");
			this.deleteAll("action_bar");

			// Store the respawn itself — login is kept for entity ID / dimension codec
			this.set("respawn", "_", data, buffer);
			return;
		}

		// ── Invalidation: clear titles ──
		if (name === "clear_titles") {
			this.deleteAll("set_title_text");
			this.deleteAll("set_title_subtitle");
			return;
		}

		// ── Invalidation: player removed from player list ──
		if (name === "player_remove") return;

		// ── Invalidation: remove entity effect ──
		if (name === "remove_entity_effect") {
			this.deleteKey("entity_effect", `${ data.entityId }:${ data.effectId }`);
			return;
		}

		// ── Invalidation: boss bar remove action ──
		if (name === "boss_bar" && data.action === 1) {
			this.deleteKey("boss_bar", `${ data.entityUUID }`);
			return;
		}

		// ── Invalidation: scoreboard objective removed ──
		if (name === "scoreboard_objective" && data.action === 1) {
			this.deleteKey("scoreboard_objective", `${ data.name }`);
			return;
		}

		// ── Store cacheable packets ──
		const keySpec = PACKET_KEYS[name];
		if (keySpec === undefined) return;

		const key = keySpec === true ? "_" : keySpec(data);

		// When a new map_chunk arrives, invalidate stale block/tile entries in that chunk
		if (name === "map_chunk") {
			this.invalidateBlocksInChunk(data.x, data.z);
		}

		this.set(name, key, data, buffer);
	};

	// ── Replay ──

	/**
	 * Returns all cached packets sorted by sequence number (insertion/update order).
	 * Login/respawn is forced first regardless of sequence.
	 */
	private getReplayPackets(): CachedPacket[] {
		const all: CachedPacket[] = [];

		for (const inner of this.cache.values()) {
			for (const pkt of inner.values()) {
				all.push(pkt);
			}
		}

		// Sort by sequence, but enforce priority groups so the client can process
		// the world correctly:
		//   0 — login / respawn: sets up dimension, registries, entity ID
		//   1 — view config: tells the client where to center & how far to render
		//       (without this, the client defaults to chunk 0,0 and discards all
		//        chunks outside that range — the root cause of empty-world on replay)
		//   2 — everything else, in original order
		const priority = (p: CachedPacket) => {
			if (p.name === "login" || p.name === "respawn") return 0;
			if (p.name === "update_view_position" || p.name === "update_view_distance" || p.name === "simulation_distance") return 1;
			return 2;
		};
		all.sort((a, b) => {
			const ap = priority(a);
			const bp = priority(b);
			if (ap !== bp) return ap - bp;
			return a.seq - b.seq;
		});

		return all;
	}

	// ── Player connection ──

	/**
	 * Spawn a client-side invisible armor stand with a name tag above a stasis chamber.
	 */
	private spawnHologram(client: MinecraftClient, dimension: string, x: number, y: number, z: number, ownerName: string) {
		const key = Proxy.hologramKey(dimension, x, y, z);
		if (this.holograms.has(key)) return;

		const entityId = this.nextFakeEntityId++;
		this.holograms.set(key, entityId);
		
		const proto = client.serializer.proto;
		client.writeRaw(proto.createPacketBuffer("packet", {
			name: "spawn_entity",
			params: {
				entityId,
				objectUUID: crypto.randomUUID(),
				type: 2, // armor_stand
				x: x + 0.5,
				y: y + 1.0,
				z: z + 0.5,
				pitch: 0,
				yaw: 0,
				headPitch: 0,
				objectData: 0,
				velocity: { x: 0, y: 0, z: 0 }
			}
		}));

		client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_metadata",
			params: {
				entityId,
				metadata: [
					{ key: 0, type: "byte", value: 0x20 }, // invisible
					{ key: 2, type: "optional_component", value: JSON.stringify({ text: ownerName, color: "gold" }) }, // custom_name
					{ key: 3, type: "boolean", value: true }, // custom_name_visible
					{ key: 5, type: "boolean", value: true }, // no_gravity
					{ key: 15, type: "byte", value: 0x08 } // marker (no hitbox)
				]
			}
		}));
	}

	/**
	 * Despawn a client-side hologram for a stasis chamber.
	 */
	private despawnHologram(client: MinecraftClient, dimension: string, x: number, y: number, z: number) {
		const key = Proxy.hologramKey(dimension, x, y, z);
		const entityId = this.holograms.get(key);
		if (entityId === undefined) return;
		this.holograms.delete(key);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- access proto for manual serialization
		const proto = (client as any).serializer.proto;
		
		client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_destroy",
			params: { entityIds: [ entityId ]}
		}));
	}

	/**
	 * Query all stasis chambers in the current dimension and spawn holograms for those in loaded chunks.
	 */
	private hasPearlInStasis(dimension: string, x: number, y: number, z: number): boolean {
		if (this.bot.game.dimension !== dimension) return false;

		const bounds = StasisColumn.getBoundingBox(new Vec3(x, y, z));
		if (!bounds) return false;

		const { pos1, pos2 } = bounds;
		const minX = Math.min(pos1.x, pos2.x);
		const maxX = Math.max(pos1.x, pos2.x);
		const minY = Math.min(pos1.y, pos2.y);
		const maxY = Math.max(pos1.y, pos2.y);
		const minZ = Math.min(pos1.z, pos2.z);
		const maxZ = Math.max(pos1.z, pos2.z);

		return Object.values(this.bot.entities)
			.filter(e => e.type === "projectile" && e.name === "ender_pearl")
			.some(e =>
				Math.floor(e.position.x) >= minX && Math.floor(e.position.x) <= maxX
				&& Math.floor(e.position.y) >= minY && Math.floor(e.position.y) <= maxY
				&& Math.floor(e.position.z) >= minZ && Math.floor(e.position.z) <= maxZ
			);
	}

	private async refreshHolograms(client: MinecraftClient) {
		if (!Client.host) return;

		const rows = await prisma.stasis.findMany({
			where: { server: Client.host, dimension: this.bot.game.dimension },
			include: { owner: true }
		});

		for (const row of rows) {

			// Only spawn if the chunk is loaded (block data accessible)
			const block = this.bot.blockAt(new Vec3(row.x, row.y, row.z));
			if (!block) continue;
			if (!this.hasPearlInStasis(row.dimension, row.x, row.y, row.z)) continue;
			this.spawnHologram(client, row.dimension, row.x, row.y, row.z, row.owner.username || row.ownerId);
		}

		Proxy.logger.log(`Spawned ${ this.holograms.size } stasis holograms`);
	}

	private onPlayerJoin(client: MinecraftClient) {
		if (this.client) {
			client.end("A player is already connected.");
			return;
		}

		this.client = client;
		const pos = this.bot.player?.entity?.position;
		const hasPos = pos && Number.isFinite(pos.x);
		Proxy.logger.log([
			`UUID of player ${ client.username } is ${ client.uuid }`,
			`${ client.username }[/${ client.socket.remoteAddress }:${ client.socket.remotePort }] logged in with entity id ${ this.bot.player?.entity?.id ?? "?" } at ([${ this.bot.game.dimension }]${ hasPos ? `${ Math.trunc(pos.x * 10) / 10 }, ${ Math.trunc(pos.y * 10) / 10 }, ${ Math.trunc(pos.z * 10) / 10 }` : "?, ?, ?" })`
		].join("\n"));

		// Replay cached world state to the connecting player.
		// Update the cached position to match what 2b2t ACTUALLY thinks (lastSent),
		// with explicit absolute flags. Using bot.entity.position would be wrong —
		// the physics simulation keeps updating it every tick even while a player is
		// connected, so it drifts from what 2b2t knows. Preserving the original flags
		// would also be wrong — if 2b2t sent a relative position correction, our
		// absolute coords would be interpreted as offsets.
		const { lastSent } = Client.physics;
		if (Number.isFinite(lastSent.x)) {
			const posMap = this.cache.get("position");
			const existing = posMap?.get("_");
			if (existing) {
				existing.data = {
					...existing.data,
					x: lastSent.x,
					y: lastSent.y,
					z: lastSent.z,
					yaw: lastSent.yaw,
					pitch: lastSent.pitch,
					flags: 0x00
				};
			}

			// Same for update_view_position (1.14+) — tells the client which chunk to center on
			const viewPosMap = this.cache.get("update_view_position");
			const viewPos = viewPosMap?.get("_");
			if (viewPos) {
				viewPos.data = {
					...viewPos.data,
					chunkX: Math.floor(lastSent.x) >> 4,
					chunkZ: Math.floor(lastSent.z) >> 4
				};
			}
		}

		const packets = this.getReplayPackets();
		const chunkCount = this.cache.get("map_chunk")?.size ?? 0;
		const lightCount = this.cache.get("update_light")?.size ?? 0;
		const viewPos = this.cache.get("update_view_position")?.get("_");
		Proxy.logger.log(`Replaying ${ packets.length } cached packets (${ chunkCount } chunks, ${ lightCount } lights, viewPos=${ viewPos ? `${ viewPos.data.chunkX },${ viewPos.data.chunkZ }` : "MISSING" })...`);

		// Hold back the position packet — it must come AFTER chunk data so the
		// client doesn't spawn in unloaded terrain, fall through the void, and rubberband.
		let positionPkt: CachedPacket | null = null;
		let replayedChunks = 0;
		let failedPackets = 0;

		for (const pkt of packets) {
			if (pkt.name === "position") {
				positionPkt = pkt;
				continue;
			}
			try {
				if (pkt.name === "update_view_position" || Proxy.RESERIALIZE_PACKETS.has(pkt.name)) {

					// Re-serialize from parsed data: update_view_position was modified
					// above, and RESERIALIZE_PACKETS have ViaVersion extra bytes.
					// We use manual serialization + writeRaw instead of write() because
					// write() goes through the async serializer Transform stream, which
					// causes these packets to arrive at the compressor AFTER all the
					// writeRaw'd packets (map_chunk, etc.). The client would then receive
					// chunks before update_view_position, discard them as out-of-range,
					// and render an empty void.
					
					client.writeRaw(client.serializer.proto.createPacketBuffer("packet", { name: pkt.name, params: pkt.data }));
				} else {

					// Default: send the raw wire buffer. This avoids structuredClone
					// corrupting Buffer fields (e.g. NBT in login, chunkData in map_chunk)
					// which breaks re-serialization via write().
					
					client.writeRaw(pkt.buffer);
				}
				if (pkt.name === "map_chunk") replayedChunks++;
			} catch (err) {
				failedPackets++;
				Proxy.logger.warn(`Failed to replay ${ pkt.name } (buf=${ pkt.buffer.length }b):`, err);
			}
		}

		Proxy.logger.log(`Replay done: ${ replayedChunks } chunks sent, ${ failedPackets } failures`);

		// Debug: sample a cached chunk buffer to verify integrity
		const sampleChunk = this.cache.get("map_chunk")?.values().next().value;
		if (sampleChunk) {
			Proxy.logger.log(`Sample chunk buffer: ${ sampleChunk.buffer.length }b, first 8 bytes: ${ Buffer.from(sampleChunk.buffer.slice(0, 8)).toString("hex") }, isBuffer=${ Buffer.isBuffer(sampleChunk.buffer) }`);
		}

		// Send position LAST so chunks are loaded before the client teleports.
		// Must also use writeRaw (via manual serialization) to maintain ordering
		// with the preceding writeRaw'd packets.
		if (positionPkt) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- access proto for manual serialization
				(client as any).writeRaw((client as any).serializer.proto.createPacketBuffer("packet", { name: positionPkt.name, params: positionPkt.data }));
			} catch (err) {
				Proxy.logger.warn("Failed to replay position:", err);
			}
		}

		// The replayed position packet has a stale teleportId — the client will
		// send teleport_confirm for it, which must NOT reach 2b2t (already confirmed).
		let replayTeleportId: number | null = (positionPkt?.data as { teleportId?: number })?.teleportId ?? null;

		// Spawn client-side armor stand holograms above all known stasis chambers
		this.refreshHolograms(client).catch(err => Proxy.logger.warn("Failed to refresh stasis holograms:", err));

		// Dynamically add/remove holograms as stasis chambers change.
		// bot.players is keyed by username; look up owner by UUID and fall back to the DB.
		const onStasisSaved = async(stasis: LegacyStasis<true>) => {
			try {
				const pos = stasis.block.position;
				if (!this.hasPearlInStasis(stasis.dimension, pos.x, pos.y, pos.z)) return;

				const inGame = Object.values(Client.bot.players).find(p => p.uuid === stasis.ownerId);
				const ownerName = inGame?.username
					?? (await prisma.player.findUnique({ where: { id: stasis.ownerId }}))?.username
					?? stasis.ownerId;
				this.spawnHologram(client, stasis.dimension, pos.x, pos.y, pos.z, ownerName);
			} catch (err) {
				Proxy.logger.warn("Failed to spawn hologram on stasisSaved:", err);
			}
		};
		const onStasisRemoved = (stasis: LegacyStasis) => {
			try {
				const pos = stasis.block.position;
				this.despawnHologram(client, stasis.dimension, pos.x, pos.y, pos.z);
			} catch { /* block may no longer be accessible */ }
		};

		Client.stasis.on("stasisSaved", onStasisSaved);
		Client.stasis.on("stasisRemoved", onStasisRemoved);

		// When the bot changes dimension (respawn), all client entities are cleared.
		// Wipe the holograms map so the guard doesn't block re-spawning, then refresh.
		const onRespawn = () => {
			this.holograms.clear();
			this.refreshHolograms(client).catch(err => Proxy.logger.warn("Failed to refresh holograms after respawn:", err));
		};
		this.bot.on("respawn", onRespawn);

		// Bridge: server → player
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- need parsed data for re-serialized packets
		const onServerPacket = (data: any, meta: PacketMeta, buffer: Buffer) => {
			if (meta.name === "keep_alive" || meta.name === "kick_disconnect") return;
			try {
				if (Proxy.RESERIALIZE_PACKETS.has(meta.name)) {

					// Re-serialize from parsed data to fix ViaVersion wire-format quirks.
					// Use manual serialization + writeRaw instead of write() to avoid
					// ordering issues between the async serializer and direct writeRaw.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- access proto for manual serialization
					(client as any).writeRaw((client as any).serializer.proto.createPacketBuffer("packet", { name: meta.name, params: data }));
				} else {

					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- writeRaw bypasses serialization
					(client as any).writeRaw(buffer);
				}
			} catch { /* client may have disconnected */ }
		};

		// Bridge: player → server (raw buffers — player sends standard packets)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- need to inspect teleport_confirm data
		const onClientPacket = (data: any, meta: PacketMeta, _buffer: Buffer, fullBuffer: Buffer) => {
			if (meta.name === "keep_alive") return;

			// Filter the teleport_confirm for our replayed position packet
			if (meta.name === "teleport_confirm" && replayTeleportId !== null && data?.teleportId === replayTeleportId) {
				replayTeleportId = null;
				return;
			}

			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- writeRaw bypasses serialization
				(this.bot._client as any).writeRaw(fullBuffer);
			} catch { /* server may have disconnected */ }
		};

		this.bot._client.on("packet", onServerPacket);
		client.on("packet", onClientPacket);

		// Cleanup on disconnect
		const cleanup = () => {
			this.bot._client.off("packet", onServerPacket);
			client.off("packet", onClientPacket);

			Client.stasis.off("stasisSaved", onStasisSaved);
			Client.stasis.off("stasisRemoved", onStasisRemoved);
			this.bot.off("respawn", onRespawn);
			this.holograms.clear();
			this.nextFakeEntityId = 0x70000000;
			this.client = null;
			Proxy.logger.log(`${ client.username } lost connection: Disconnected`);
		};

		client.on("end", cleanup);
		client.on("error", (err: Error) => {
			Proxy.logger.warn(`Client error (non-fatal): ${ err?.message }`);
		});
	}

	/** Whether a player is currently controlling the bot */
	public get connected(): boolean {
		return this.client !== null;
	}

	/** Shut down the proxy server and clean up resources */
	public close() {
		this.bot._client.off("packet", this.onPacket);
		this.client?.end("Proxy server shutting down.");
		this.server?.close();
	}
}
