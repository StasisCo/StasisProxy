import chalk from "chalk";
import type { Client as MinecraftClient, PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Logger } from "~/class/Logger";

/**
 * A single cached packet entry, keyed inside the cache by its packet name and
 * an inner key (or `"_"` for singletons). Insertion order is preserved via the
 * monotonically-incrementing {@link CachedPacket.seq} field so replay can
 * reconstruct the original arrival order even when entries are mutated.
 */
export interface CachedPacket {
	seq: number;
	name: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	data: any;

	/** Raw packet buffer for `writeRaw` replay (avoids re-serialization issues). */
	buffer: Buffer;
}

/**
 * Defines how a packet is keyed in the cache.
 * - A function returning a string keys the packet by that string — only the
 *   latest value per key is kept.
 * - `true` means the packet is stored once (singleton).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- packet shapes are dynamic
const PACKET_KEYS: Record<string, true | ((data: any) => string)> = {

	// ── Login & Configuration (singletons) ──
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

	// ── Title / Action bar (latest value only) ──
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
	"entity_velocity": d => `${ d.entityId }`,
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
	"game_state_change": d => `${ d.reason }`
};

/** Names of all entity-keyed packets — used for invalidation when an entity is destroyed. */
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

/**
 * Packets that must be re-serialized via {@link MinecraftClient.write} (or manual
 * proto serialization) instead of `writeRaw`. ViaVersion on 2b2t can produce
 * wire bytes with extra data that the vanilla client rejects — re-serializing
 * from the parsed data fixes this.
 */
export const RESERIALIZE_PACKETS = new Set([ "entity_equipment" ]);

/**
 * Records a rolling snapshot of the upstream server's world state by caching
 * one entry per "key" per packet name. When a proxy client connects, the cache
 * is replayed in original arrival order so the client sees a consistent world
 * without needing the full chunk/entity stream.
 *
 * Owns a `packet` listener on the bot's client; call {@link PacketCache.close}
 * to release it.
 */
export class PacketCache {

	private static readonly logger = new Logger(chalk.blue("PACKETS"));

	/**
	 * The packet cache. Outer map is keyed by packet name, inner map is keyed
	 * by the packet's unique key (or `"_"` for singletons).
	 */
	private readonly cache = new Map<string, Map<string, CachedPacket>>();

	/** Monotonically increasing counter to preserve insertion/update order. */
	private seq = 0;

	/**
	 * Creates a new PacketCache and immediately begins recording packets from
	 * the bot's upstream server connection.
	 * @param bot - The mineflayer bot whose upstream packets should be cached
	 */
	constructor(private readonly bot: Mineflayer) {
		bot._client.on("packet", this.onPacket);
	}

	/**
	 * The number of cached entries for a given packet name (0 if none).
	 */
	public size(name: string): number {
		return this.cache.get(name)?.size ?? 0;
	}

	/**
	 * Get the cached entry for a packet name and key, or `undefined` if none.
	 */
	public peek(name: string, key = "_"): CachedPacket | undefined {
		return this.cache.get(name)?.get(key);
	}

	/**
	 * Returns all cached packets sorted by sequence number (insertion/update order).
	 *
	 * Login/respawn is forced first regardless of sequence so the client can set
	 * up the dimension/registries/entity ID. View configuration packets are sent
	 * second so the client knows where to center and how far to render — without
	 * this, the client defaults to chunk 0,0 and discards all chunks outside that
	 * range, producing an empty void.
	 */
	public getReplayPackets(): CachedPacket[] {
		const all: CachedPacket[] = [];

		for (const inner of this.cache.values()) {
			for (const pkt of inner.values()) all.push(pkt);
		}

		const priority = (p: CachedPacket) => {
			if (p.name === "login" || p.name === "respawn") return 0;
			if (p.name === "update_view_position" || p.name === "update_view_distance" || p.name === "simulation_distance") return 1;
			return 2;
		};

		all.sort((a, b) => {
			const ap = priority(a);
			const bp = priority(b);
			return ap !== bp ? ap - bp : a.seq - b.seq;
		});

		return all;
	}

	/**
	 * Mutate the cached `position` packet's coordinates so the client respawns
	 * at the same place the upstream server thinks the bot is. Also updates
	 * `update_view_position` so chunks center correctly. If either entry is
	 * missing this is a no-op.
	 */
	public updatePosition(lastSent: { x: number; y: number; z: number; yaw: number; pitch: number }) {
		if (!Number.isFinite(lastSent.x)) return;

		const pos = this.cache.get("position")?.get("_");
		if (pos) {
			pos.data = {
				...pos.data,
				x: lastSent.x,
				y: lastSent.y,
				z: lastSent.z,
				yaw: lastSent.yaw,
				pitch: lastSent.pitch,
				flags: 0x00
			};
		}

		const view = this.cache.get("update_view_position")?.get("_");
		if (view) {
			view.data = {
				...view.data,
				chunkX: Math.floor(lastSent.x) >> 4,
				chunkZ: Math.floor(lastSent.z) >> 4
			};
		}
	}

	/** Detach the upstream packet listener. Should be called on shutdown. */
	public close() {
		this.bot._client.off("packet", this.onPacket);
	}

	// ─────────────────────────────── internals ───────────────────────────────

	private set(name: string, key: string, data: unknown, buffer: Buffer) {
		let inner = this.cache.get(name);
		if (!inner) {
			inner = new Map();
			this.cache.set(name, inner);
		}

		// Deep-copy: parsed objects may contain views into the protocol stream's
		// internal pool whose memory can be reused after the event handler.
		// Copy the raw buffer too — used for writeRaw replay to avoid
		// re-serialization issues (structuredClone converts Buffers to Uint8Array,
		// corrupting chunk data).
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
		for (const name of ENTITY_PACKET_NAMES) this.deleteKey(name, key);

		// Also remove entity effects (keyed as entityId:effectId)
		const effects = this.cache.get("entity_effect");
		if (effects) {
			for (const k of effects.keys()) {
				if (k.startsWith(`${ entityId }:`)) effects.delete(k);
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

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	private readonly onPacket = (data: any, meta: PacketMeta, buffer: Buffer) => {
		const { name } = meta;

		// ── Invalidations ──
		if (name === "entity_destroy") {
			if (Array.isArray(data?.entityIds)) for (const id of data.entityIds) this.deleteEntity(id);
			return;
		}

		if (name === "unload_chunk") {
			const chunkKey = `${ data.chunkX },${ data.chunkZ }`;
			this.deleteKey("map_chunk", chunkKey);
			this.deleteKey("update_light", chunkKey);
			this.invalidateBlocksInChunk(data.chunkX, data.chunkZ);
			return;
		}

		if (name === "respawn") {
			for (const pktName of ENTITY_PACKET_NAMES) this.deleteAll(pktName);
			for (const pktName of [
				"entity_effect", "map_chunk", "update_light",
				"scoreboard_objective", "scoreboard_display_objective", "scoreboard_score",
				"teams", "boss_bar", "window_items", "set_slot",
				"block_change", "multi_block_change", "tile_entity_data",
				"initialize_world_border", "world_border_center", "world_border_size",
				"position", "update_health", "experience", "update_view_position",
				"game_state_change", "spawn_position",
				"set_title_text", "set_title_subtitle", "set_title_time", "action_bar"
			]) this.deleteAll(pktName);

			// Login is kept for entity ID / dimension codec; respawn overrides.
			this.set("respawn", "_", data, buffer);
			return;
		}

		if (name === "clear_titles") {
			this.deleteAll("set_title_text");
			this.deleteAll("set_title_subtitle");
			return;
		}

		if (name === "remove_entity_effect") {
			this.deleteKey("entity_effect", `${ data.entityId }:${ data.effectId }`);
			return;
		}

		if (name === "boss_bar" && data.action === 1) {
			this.deleteKey("boss_bar", `${ data.entityUUID }`);
			return;
		}

		if (name === "scoreboard_objective" && data.action === 1) {
			this.deleteKey("scoreboard_objective", `${ data.name }`);
			return;
		}

		// ── Cacheable packets ──
		// Wrapped in try-catch: if the key spec or structuredClone throws (e.g.
		// from an unexpected ViaProxy packet structure), the error must NOT
		// propagate out of this listener. EventEmitter stops calling subsequent
		// listeners the moment one throws — which would silently prevent the
		// proxy bridge from forwarding the packet to the connected client.
		try {
			const keySpec = PACKET_KEYS[name];
			if (keySpec === undefined) return;

			const key = keySpec === true ? "_" : keySpec(data);

			// When a new map_chunk arrives, invalidate stale block/tile entries.
			if (name === "map_chunk") this.invalidateBlocksInChunk(data.x, data.z);

			// entity_equipment: merge incoming slots into the existing cache entry
			// so individual per-slot updates (common with ViaVersion) don't wipe
			// previously cached slots for the same entity.
			if (name === "entity_equipment") {
				const existing = this.cache.get("entity_equipment")?.get(key);
				if (existing) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped packet data
					const prev = (existing.data as any).equipments as Array<{ slot: number; item: unknown }>;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped packet data
					const incoming = (data as any).equipments as Array<{ slot: number; item: unknown }>;
					const merged = new Map<number, { slot: number; item: unknown }>(prev.map(e => [ e.slot, e ]));
					for (const entry of incoming) merged.set(entry.slot, entry);
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped packet data
					(data as any).equipments = [ ...merged.values() ];

					// The raw buffer is now stale — RESERIALIZE_PACKETS forces
					// reconstruction. Store a zero-length sentinel so writeRaw is
					// never accidentally used.
					this.set(name, key, data, Buffer.alloc(0));
					return;
				}
			}

			this.set(name, key, data, buffer);
		} catch (err) {
			PacketCache.logger.warn(`Cache error for ${ name } (packet will still be forwarded):`, err);
		}
	};

}
