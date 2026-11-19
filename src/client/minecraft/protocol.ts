import mcData from "minecraft-data";
import type { Item } from "prismarine-item";

/**
 * The one Minecraft version this proxy speaks — upstream as the bot, and downstream to proxied
 * players. The packet handling throughout the codebase is written against this version's wire
 * format (NBT text components, item components, the configuration state), so it is pinned here
 * rather than taken from the environment.
 */
export const PROTOCOL_VERSION = "1.20.6";

/** minecraft-data for {@link PROTOCOL_VERSION}, with the durability fix below applied. */
export const registry = mcData(PROTOCOL_VERSION);

/**
 * Resolve the version to connect with. `MC_VERSION` used to select it; a value other than
 * {@link PROTOCOL_VERSION} is now ignored (with a warning) rather than honoured, because the rest
 * of the code would mis-parse any other wire format.
 */
export function resolveVersion(requested: string | undefined, warn: (message: string) => void): string {
	if (requested && requested !== PROTOCOL_VERSION) {
		warn(`MC_VERSION=${ requested } is ignored — this build speaks ${ PROTOCOL_VERSION } only. Remove MC_VERSION from your environment.`);
	}
	return PROTOCOL_VERSION;
}

// ─── Item durability ─────────────────────────────────────────────────────────

/**
 * minecraft-data ships every damageable 1.20.5/1.20.6 item with `maxDurability: 1` (1.20.4 and
 * 1.21.x are correct, and no durability changed in between). prismarine-item copies the value
 * onto every item it builds, so left alone, AutoXP thinks all gear is broken, KillAura discards
 * every sword, and Presence reports nonsense. Patch the shared registry objects in place, once,
 * from 1.20.1 — the cached minecraft-data instance is the same object prismarine-registry and
 * mineflayer build their item classes from, so this reaches every item the bot ever sees.
 */
(function patchMaxDurability() {
	const reference = mcData("1.20.1");
	for (const item of registry.itemsArray) {
		if (item.maxDurability !== 1) continue;
		const correct = reference.itemsByName[item.name]?.maxDurability;
		if (correct !== undefined) item.maxDurability = correct;
	}
})();

/**
 * An item's enchantments as `{ name, lvl }`, whatever the item format.
 *
 * On 1.20.5+ prismarine-item returns the raw `enchantments` component from `item.enchants` — an
 * object `{ enchantments: [{ id, level }], showTooltip }` — instead of the normalized list it
 * returns for NBT items, so `.find()` on it throws.
 */
export function enchantsOf(item: Item): { name: string; lvl: number }[] {
	const raw = item.enchants as unknown;
	if (Array.isArray(raw)) return raw as { name: string; lvl: number }[];

	const list = (raw as { enchantments?: { id: number; level: number }[] } | null | undefined)?.enchantments;
	if (!Array.isArray(list)) return [];

	return list.flatMap(({ id, level }) => {
		const name = registry.enchantments[id]?.name;
		return name ? [ { name, lvl: level } ] : [];
	});
}

// ─── Entities ────────────────────────────────────────────────────────────────

/** Numeric entity type id for {@link PROTOCOL_VERSION} (these shift between versions: player is 128 here, 122 on 1.20.1). */
export function entityTypeId(name: string): number {
	const entity = registry.entitiesByName[name];
	if (!entity) throw new Error(`Unknown entity type ${ name } in ${ PROTOCOL_VERSION }`);
	return entity.id;
}

// ─── Clientbound position flags ──────────────────────────────────────────────

/** Relative-axis flags of a clientbound `position` packet. Parsed as an object on 1.20.6, a bitmask on older versions. */
export type PositionFlags = number | { x?: boolean; y?: boolean; z?: boolean; yaw?: boolean; pitch?: boolean };

const FLAG_BITS = { x: 0x01, y: 0x02, z: 0x04, yaw: 0x08, pitch: 0x10 } as const;

/** Whether `axis` of a clientbound `position` is relative to the current value. */
export function isRelative(flags: PositionFlags | undefined, axis: keyof typeof FLAG_BITS): boolean {
	if (typeof flags === "number") return (flags & FLAG_BITS[axis]) !== 0;
	return flags?.[axis] === true;
}

/**
 * All-absolute `position` flags. Must be the object form: the 1.20.6 bitflags serializer ignores a
 * plain number and writes 0, so a bitmask would silently come out absolute anyway.
 */
export const ABSOLUTE_POSITION_FLAGS = Object.freeze({ x: false, y: false, z: false, yaw: false, pitch: false });

// ─── Per-state write guard ───────────────────────────────────────────────────

/** Serverbound packet names that exist in each protocol state. */
const SERVERBOUND_NAMES: Record<string, Set<string>> = Object.fromEntries(
	[ "handshaking", "status", "login", "configuration", "play" ].map(state => {
		const proto = (registry.protocol as unknown as Record<string, { toServer?: { types?: { packet?: unknown } } }>)[state];
		const mapper = (proto?.toServer?.types?.packet as [ string, { type: [ string, { mappings: Record<string, string> }] }[] ] | undefined)?.[1]?.[0]?.type?.[1]?.mappings;
		return [ state, new Set(Object.values(mapper ?? {})) ];
	})
);

/**
 * Drop writes of packets that do not exist in the client's current protocol state.
 *
 * Since 1.20.2 the server can pull a client out of `play` into `configuration` (Velocity does it
 * on every backend switch — 2b2t's queue → main server is one). minecraft-protocol does not
 * reject a play packet written in that state: the name misses the configuration mapper and it
 * goes out as a bare `0x00` frame, a malformed `client_information` that gets the bot kicked.
 * The physics loop alone writes a movement packet every 50 ms, so without this guard every
 * server switch would be a disconnect. Install before anything else wraps `client.write`.
 */
export function guardStateWrites(client: { state: string; write: (name: string, params: unknown) => void }, onDrop?: (name: string, state: string) => void) {
	const write = client.write.bind(client);
	client.write = (name: string, params: unknown) => {
		const valid = SERVERBOUND_NAMES[client.state];
		if (valid && !valid.has(name)) {
			onDrop?.(name, client.state);
			return;
		}
		write(name, params);
	};
}
