import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { MinecraftClient } from "../MinecraftClient";

/** Block face indices as the protocol numbers them. */
export const Face = {
	DOWN: 0,
	UP: 1,
	NORTH: 2,
	SOUTH: 3,
	WEST: 4,
	EAST: 5
} as const;

export type FaceIndex = typeof Face[keyof typeof Face];

/** Unit offset for each face index, in the order above. */
const FACE_OFFSETS: readonly Vec3Like[] = [
	{ x: 0, y: -1, z: 0 },
	{ x: 0, y: 1, z: 0 },
	{ x: 0, y: 0, z: -1 },
	{ x: 0, y: 0, z: 1 },
	{ x: -1, y: 0, z: 0 },
	{ x: 1, y: 0, z: 0 }
];

/** Offset from a block's minimum corner to the centre of one of its faces. */
export function faceCentre(face: FaceIndex): Vec3 {
	const offset = FACE_OFFSETS[face] ?? FACE_OFFSETS[1]!;
	return new Vec3(0.5 + offset.x * 0.5, 0.5 + offset.y * 0.5, 0.5 + offset.z * 0.5);
}

/** The face whose outward normal points from `pos` toward `from`. */
export function faceToward(pos: Vec3Like, from: Vec3Like): FaceIndex {
	const dx = from.x - (pos.x + 0.5);
	const dy = from.y - (pos.y + 0.5);
	const dz = from.z - (pos.z + 0.5);
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const az = Math.abs(dz);
	if (ay >= ax && ay >= az) return dy >= 0 ? Face.UP : Face.DOWN;
	if (ax >= az) return dx >= 0 ? Face.EAST : Face.WEST;
	return dz >= 0 ? Face.SOUTH : Face.NORTH;
}

/**
 * Sliding-window rate limiter. One instance per packet class the server (or Grim) budgets
 * separately. Limits mirror the ones the Java client ships with for this server.
 */
class RateBucket {

	private readonly hits: number[] = [];

	public constructor(public readonly name: string, public readonly limit: number, public readonly windowMs: number) {}

	private prune(now: number) {
		while (this.hits.length > 0 && now - this.hits[0]! > this.windowMs) this.hits.shift();
	}

	/**
	 * @param now Current timestamp
	 * @param consume Whether to record a hit when the check passes
	 * @returns whether the budget allows another packet
	 */
	public check(now: number, consume: boolean): boolean {
		this.prune(now);
		if (this.hits.length >= this.limit) return false;
		if (consume) this.hits.push(now);
		return true;
	}

	public remaining(now: number): number {
		this.prune(now);
		return this.limit - this.hits.length;
	}

}

/**
 * Central choke point for every gameplay packet that isn't movement.
 *
 * Two jobs:
 *
 * 1. **Budgeting.** Grim and Paper both meter interactions, player actions and container clicks
 *    separately. Modules used to emit these freely (AutoXP threw twenty XP bottles a second),
 *    which reads as automation regardless of how correct each individual packet is.
 * 2. **Ordering.** Container clicks must arrive while the server believes we are not sprinting —
 *    Grim's "clicked while sprinting" check flags *and cancels* the click, which is why silent
 *    swaps used to silently not happen. Every click routed through here is wrapped in a
 *    sprint drop/restore pair.
 *
 * Interaction packets carry no rotation on 1.20.1, so callers that need the server to raycast
 * somewhere specific must put the rotation on the wire first — see {@link RotationManager}.
 */
export class InteractionManager {

	/** Overall outgoing packet budget. */
	public readonly global = new RateBucket("global", 1249, 4000);

	/** `entity_action` / `block_dig` player actions. */
	public readonly action = new RateBucket("action", 120, 500);

	/** `window_click` container clicks. */
	public readonly click = new RateBucket("click", 79, 4200);

	/** `use_item` / `block_place` interactions. */
	public readonly interact = new RateBucket("interact", 9, 300);

	/** Milliseconds before the same block position may be interacted with again. */
	private static readonly BLOCK_COOLDOWN_MS = 150;

	/** Per-action sequence counter — vanilla increments this, a constant is a tell. */
	private sequence = 0;

	private readonly blockCooldowns = new Map<string, number>();

	private lastCleanup = 0;

	public constructor(private readonly bot: Bot) {}

	/** Next block-action sequence number. */
	public nextSequence(): number {
		return ++this.sequence;
	}

	/**
	 * Reserve `count` packets against the global budget and one specific bucket. Either both
	 * buckets have room and both are charged, or neither is touched.
	 */
	private budget(now: number, bucket: RateBucket | null, count = 1): boolean {
		if (this.global.remaining(now) < count) return false;
		if (bucket && bucket.remaining(now) < count) return false;
		for (let i = 0; i < count; i++) {
			this.global.check(now, true);
			bucket?.check(now, true);
		}
		return true;
	}

	private purge(now: number) {
		if (now - this.lastCleanup < 5000) return;
		this.lastCleanup = now;
		for (const [ key, at ] of this.blockCooldowns) {
			if (now - at > 10_000) this.blockCooldowns.delete(key);
		}
	}

	// ─── Item use ────────────────────────────────────────────────

	/**
	 * Begin using the held item (eat, drink, throw, draw). Send this **once** per use — a real
	 * client sends one `use_item` and then simply holds the key down. Re-sending every tick is
	 * both over budget and pointless, since the server ignores a start while already using.
	 * @param offHand Whether to use the off-hand item
	 * @param reserve Interaction budget to leave untouched. Continuous, low-priority users (XP
	 *                bottles) pass a reserve so they can't starve the ones that matter — a
	 *                dropped stasis interaction is a pearl that doesn't come back.
	 * @returns whether the packet was sent
	 */
	public useItem(offHand = false, reserve = 0): boolean {
		const now = Date.now();
		if (reserve > 0 && this.interact.remaining(now) <= reserve) return false;
		if (!this.budget(now, this.interact)) return false;

		this.bot._client.write("use_item", {
			hand: offHand ? 1 : 0,
			sequence: this.nextSequence()
		});
		return true;
	}

	/**
	 * Interact with a block face.
	 *
	 * The cursor must lie **on the clicked face**, not merely inside the block: the anticheat
	 * reconstructs the click and rejects a hit vector that could not have come from a ray
	 * striking that face. Use {@link faceCentre}, or the intersection point from a raycast.
	 *
	 * @param pos Block position
	 * @param face Face being clicked
	 * @param cursor Hit position relative to the block's minimum corner (each component 0..1)
	 * @param options.offHand Use the off-hand item
	 * @param options.insideBlock Whether the player's eye is inside the target block
	 * @param options.ignoreCooldown Bypass the per-block retry cooldown
	 * @returns whether the packet was sent
	 */
	public useItemOn(pos: Vec3Like, face: FaceIndex, cursor: Vec3Like, options: {
		offHand?: boolean;
		insideBlock?: boolean;
		ignoreCooldown?: boolean;
	} = {}): boolean {

		const now = Date.now();
		this.purge(now);

		const key = `${ pos.x },${ pos.y },${ pos.z }`;
		if (!options.ignoreCooldown) {
			const last = this.blockCooldowns.get(key);
			if (last !== undefined && now - last < InteractionManager.BLOCK_COOLDOWN_MS) return false;
		}

		if (!this.budget(now, this.interact)) return false;
		this.blockCooldowns.set(key, now);

		const location = new Vec3(pos.x, pos.y, pos.z);
		const base = {
			location,
			direction: face,
			hand: options.offHand ? 1 : 0,
			cursorX: cursor.x,
			cursorY: cursor.y,
			cursorZ: cursor.z
		};

		if (this.bot.supportFeature("blockPlaceHasInsideBlock")) {
			this.bot._client.write("block_place", {
				...base,
				insideBlock: options.insideBlock ?? false,
				sequence: this.nextSequence()
			});
		} else if (this.bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
			this.bot._client.write("block_place", base);
		} else if (this.bot.supportFeature("blockPlaceHasHandAndIntCursor")) {
			this.bot._client.write("block_place", {
				...base,
				cursorX: Math.round(cursor.x * 16),
				cursorY: Math.round(cursor.y * 16),
				cursorZ: Math.round(cursor.z * 16)
			});
		} else {
			return false;
		}

		return true;

	}

	/**
	 * Release the item currently being used. Only call this when the server actually believes an
	 * item is in use — a release with no matching start is not something a real client emits.
	 * @returns whether the packet was sent
	 */
	public releaseUseItem(): boolean {
		const now = Date.now();
		if (!this.budget(now, this.action)) return false;

		this.bot._client.write("block_dig", {
			status: 5,
			location: new Vec3(0, 0, 0),
			face: 0,
			sequence: 0
		});
		return true;
	}

	// ─── Hand / slot management ──────────────────────────────────

	/**
	 * Exchange main hand and off-hand.
	 *
	 * This is the cheap way to get something into the off-hand: twelve bytes, no container menu,
	 * and therefore no `stateId` to desync. `bot.equip(item, "off-hand")` instead performs two
	 * pickup clicks with a live cursor, which is both larger and far more heavily validated.
	 * @returns whether the packet was sent
	 */
	public swapOffhand(): boolean {
		const now = Date.now();
		if (!this.budget(now, this.action)) return false;

		this.bot._client.write("block_dig", {
			status: 6,
			location: new Vec3(0, 0, 0),
			face: 0,
			sequence: 0
		});
		return true;
	}

	/**
	 * Select a hotbar slot. Cheapest possible swap — three bytes, no menu state.
	 * @param slot Hotbar index, 0..8
	 * @returns whether the packet was sent (false when already selected or over budget)
	 */
	public setHotbarSlot(slot: number): boolean {
		if (slot < 0 || slot > 8) return false;
		if (this.bot.quickBarSlot === slot) return false;

		const now = Date.now();
		if (!this.budget(now, null)) return false;

		this.bot.setQuickBarSlot(slot);
		return true;
	}

	/** Swing the arm. */
	public swingArm(offHand = false): boolean {
		const now = Date.now();
		if (!this.budget(now, this.action)) return false;

		this.bot._client.write("arm_animation", { hand: offHand ? 1 : 0 });
		return true;
	}

	// ─── Container clicks ────────────────────────────────────────

	/**
	 * Perform a container click with sprint dropped on the wire around it.
	 *
	 * `bot.clickWindow` writes its packet synchronously before awaiting the server's slot
	 * update, so the drop/click/restore trio arrives in that order even though this returns a
	 * promise. Prefer {@link setHotbarSlot} or {@link swapOffhand} whenever they would do —
	 * container clicks carry a `stateId` and a predicted slot map, all of which the anticheat
	 * re-derives.
	 *
	 * @param slot Slot index within the open window
	 * @param button Mouse button / hotbar index, depending on mode
	 * @param mode Click mode (0 pickup, 1 shift, 2 hotbar swap, 4 throw, ...)
	 * @returns a promise that resolves when the click is confirmed, or null when over budget
	 */
	public clickWindow(slot: number, button: number, mode: number): Promise<void> | null {
		const now = Date.now();
		if (!this.budget(now, this.click)) return null;

		return MinecraftClient.physics.withSprintDropped(() => this.bot.clickWindow(slot, button, mode));
	}

	/**
	 * Move an item between two slots, dropping sprint for the duration.
	 * @returns a promise that resolves when both clicks are confirmed, or null when over budget
	 */
	public moveSlotItem(source: number, destination: number): Promise<void> | null {
		const now = Date.now();

		// Two clicks — reserve both up front so we never strand an item on the cursor.
		if (!this.budget(now, this.click, 2)) return null;

		return MinecraftClient.physics.withSprintDropped(() => this.bot.moveSlotItem(source, destination));
	}

	/**
	 * Bring an item from the main inventory into the hotbar with a single atomic swap click.
	 *
	 * Mode 2 exchanges the two slots server-side in one operation, so nothing is ever left on the
	 * cursor — unlike the pickup/place pair `bot.equip` and `bot.moveSlotItem` use, which leaves a
	 * live cursor between two separately validated clicks.
	 *
	 * @param item The item to bring into the hotbar
	 * @returns a promise that resolves when the swap is confirmed, or null when it could not be
	 *          attempted (cursor busy, already in the hotbar, or over budget)
	 */
	public stageIntoHotbar(item: Item): Promise<void> | null {
		const inventory = this.bot.inventory;
		if (inventory.selectedItem) return null;
		if (item.slot >= inventory.hotbarStart && item.slot < inventory.hotbarStart + 9) return null;

		// Prefer an empty hotbar slot so the swap doesn't displace a totem or a weapon.
		let hotbarIndex = -1;
		for (let i = 0; i < 9; i++) {
			if (!inventory.slots[inventory.hotbarStart + i]) {
				hotbarIndex = i;
				break;
			}
		}
		if (hotbarIndex === -1) hotbarIndex = this.bot.quickBarSlot;

		return this.clickWindow(item.slot, hotbarIndex, 2);
	}

	/** Toss a whole stack, dropping sprint for the duration. */
	public tossStack(item: Item): Promise<void> | null {
		const now = Date.now();
		if (!this.budget(now, this.click)) return null;

		return MinecraftClient.physics.withSprintDropped(() => this.bot.tossStack(item));
	}

	// ─── Entities ────────────────────────────────────────────────

	/**
	 * Attack an entity. The caller is responsible for having put an aiming rotation on the wire
	 * first — the server validates reach and line of sight against the rotation it last saw.
	 * @returns whether the attack was sent
	 */
	public attack(entity: Entity): boolean {
		const now = Date.now();
		if (!this.budget(now, this.action)) return false;

		this.bot.attack(entity);
		return true;
	}

}
