import chalk from "chalk";
import mcData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Physics, PlayerState, type Controls } from "prismarine-physics";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "../MinecraftClient";
import { RotationManager } from "./RotationManager";

const PI = Math.PI;
const PI_2 = Math.PI * 2;
const TO_DEG = 180 / PI;
const TO_RAD = PI / 180;
const PHYSICS_INTERVAL_MS = 50;

/**
 * Metadata index of `LIVING_ENTITY_FLAGS` on 1.20.1. Bit 0x01 is "hand active" — the server's
 * own view of whether we are using an item — and 0x02 selects the hand.
 */
const META_LIVING_FLAGS = 8;

/**
 * Longest an item use may stay active before we stop believing in it.
 *
 * Food is 32 ticks and nothing else the bot uses is slower, so three seconds is well clear of any
 * real use plus a round trip. Past that it is a desync — most likely a state change we never
 * observed — and letting it stand pins movement at item-use speed indefinitely.
 */
const ITEM_USE_MAX_TICKS = 60;

function toNotchianYaw(yaw: number): number {
	return TO_DEG * (PI - yaw);
}

function toNotchianPitch(pitch: number): number {
	return TO_DEG * (-pitch);
}

function fromNotchianYaw(yaw: number): number {
	return ((PI - yaw * TO_RAD) % PI_2 + PI_2) % PI_2;
}

function fromNotchianPitch(pitch: number): number {
	return ((-pitch * TO_RAD + PI) % PI_2 + PI_2) % PI_2 - PI;
}

/** Wrap a degree delta into (-180, 180]. */
function wrapDegrees(degrees: number): number {
	let wrapped = degrees % 360;
	if (wrapped >= 180) wrapped -= 360;
	if (wrapped < -180) wrapped += 360;
	return wrapped;
}

/** Packets that mineflayer's physics loop sends — we suppress them and send our own */
const MOVEMENT_PACKETS = new Set([ "position", "position_look", "look", "flying" ]);

export class PhysicsManager {

	public static readonly logger = new Logger(chalk.hex("#a3e635")("PHYSICS"));

	private engine: ReturnType<typeof Physics> | null = null;

	/** Silent rotation dispatch — see {@link RotationManager}. */
	public readonly rotation: RotationManager;

	/** Original bot._client.write, bypasses our suppression filter */
	private readonly rawWrite: typeof this.bot._client.write;

	public readonly controls = {
		forward: false,
		back: false,
		left: false,
		right: false,
		jump: false,
		sprint: false,
		sneak: false
	};

	/** Track previous sprint/sneak state to send entity_action packets on change */
	private lastSprint = false;
	private lastSneak = false;

	/**
	 * Whether an item use is in flight from our side. Set when we put a `use_item` on the wire,
	 * cleared when we release or when the server tells us the use ended.
	 *
	 * This is deliberately optimistic: a vanilla client also starts slowing down the moment it
	 * right-clicks, a round trip before the server agrees, so starting here keeps our simulated
	 * movement aligned with what the anticheat predicts from the same packet.
	 */
	private usingItemLocal = false;

	/**
	 * The server's own view of whether we are using an item, read off our entity's
	 * `LIVING_ENTITY_FLAGS` metadata. This is the only authoritative signal — the flags
	 * mineflayer maintains locally are set by us, so they can never disagree with us and are
	 * useless for detecting that an eat silently failed.
	 */
	public serverUsingItem = false;

	/**
	 * Whether movement should be treated as item-use constrained. True when either side believes
	 * an item is in use: erring toward the slower of the two predictions is always safe, because
	 * moving *less* than the server expects is legal and moving more is not.
	 */
	public get isUsingItem(): boolean {
		return this.usingItemLocal || this.serverUsingItem;
	}

	/** Physics ticks the item-use state has been continuously set, for the stall watchdog. */
	private itemUseTicks = 0;

	/** Note that a `use_item` has gone out, so physics starts applying the use-item slowdown. */
	public beginItemUse() {
		this.usingItemLocal = true;
	}

	/** Note that the item use has ended (released by us, or ended by the server). */
	public endItemUse() {
		this.usingItemLocal = false;
	}

	/**
	 * Give up on an item use that has outlived any real one.
	 *
	 * Both halves of the item-use state are edge-driven — ours by sending `use_item`, the
	 * server's by a metadata change — so either can be left set if the matching edge never
	 * arrives. A stuck flag costs 80% of the bot's movement speed silently and forever, which is
	 * far worse than briefly predicting an eat that is still going, so time it out.
	 */
	private tickItemUseWatchdog() {
		if (!this.usingItemLocal && !this.serverUsingItem) {
			this.itemUseTicks = 0;
			return;
		}

		if (++this.itemUseTicks <= ITEM_USE_MAX_TICKS) return;

		this.usingItemLocal = false;
		this.serverUsingItem = false;
		this.itemUseTicks = 0;
	}

	/** Desired yaw/pitch snapshot for this tick — what physics simulates with AND what gets sent */
	private smoothYaw = 0;
	private smoothPitch = 0;

	/** Last sent packet values for delta detection */
	public readonly lastSent = {
		x: 0, y: 0, z: 0,
		yaw: 0, pitch: 0,
		onGround: false,
		time: 0
	};

	public readonly onPreTick: (() => void)[] = [];

	private interval: NodeJS.Timeout | null = null;

	/** Physics ticks since this connection started. */
	private tickCount = 0;

	/** Tick of the last server-forced position change, for the post-teleport jump gate. */
	private lastTeleportTick = -Infinity;

	/** Last self knockback received, restored across a correction if not yet simulated. */
	private pendingKnockback: { x: number; y: number; z: number; time: number } | null = null;

	constructor(public readonly bot: Bot) {

		this.rotation = new RotationManager(this);

		// Intercept bot._client.write to suppress mineflayer's outgoing movement packets.
		this.rawWrite = bot._client.write.bind(bot._client);
		const origWrite = this.rawWrite;
		bot._client.write = function(name: string, data: unknown) {
			if (MOVEMENT_PACKETS.has(name)) return;

			// While a proxy client is attached, IT is the one processing teleports — its own
			// teleport_confirm is bridged upstream with the correct timing. Mineflayer's handler
			// still runs and would confirm the same teleport instantly, before the client has
			// even received it: the server then sees a confirmed teleport followed by movement
			// packets still at the pre-teleport position (the client's round trip), which reads
			// as an immediate new violation — a setback/confirm loop that escalates to a kick.
			if (name === "teleport_confirm" && MinecraftClient.proxy?.connected) return;

			// Same story for play pings: the anticheat brackets its checks with `ping`
			// transactions and requires exactly one ordered `pong` each. Mineflayer auto-pongs
			// every ping (game.js) while the bridged client pongs too — double responses drift
			// the anticheat's transaction bookkeeping until every movement check misfires,
			// which froze proxied players in a setback storm after about a minute.
			if (name === "pong" && MinecraftClient.proxy?.connected) return;

			origWrite(name, data);
		} as typeof bot._client.write;

		// Disable mineflayer's physics simulation permanently.
		// Use defineProperty so nothing can set it back to true (mineflayer's position handler does).
		Object.defineProperty(bot, "physicsEnabled", {
			get: () => false,
			set: () => {},
			configurable: true
		});

		// Handle server-initiated teleport/position changes.
		bot.on("forcedMove", () => {
			this.smoothYaw = bot.entity.yaw;
			this.smoothPitch = bot.entity.pitch;

			// Mineflayer's teleport handling just zeroed our velocity. If a knockback arrived
			// in this same window and hasn't been through a simulation step yet, restore it:
			// dropping it means the next tick moves without the push the server already applied
			// on its side, which mispredicts again and sustains the correction loop.
			if (this.pendingKnockback && performance.now() - this.pendingKnockback.time < 150) {
				bot.entity.velocity.set(this.pendingKnockback.x, this.pendingKnockback.y, this.pendingKnockback.z);
			}

			// Mineflayer unconditionally sets onGround=false on position corrections
			// (physics.js L418). With velocity zeroed, the physics engine needs 2 ticks
			// to re-detect ground (gravity must produce negative Y velocity first).
			// During those ticks, airborne acceleration (0.02) is used instead of ground
			// acceleration (~0.1), causing ~5x slower movement. On correction-heavy
			// servers this creates a persistent slow-walk loop.
			// Fix: check for solid ground below the corrected position.
			const feetBlock = bot.blockAt(bot.entity.position.offset(0, -0.2, 0));
			if (feetBlock && feetBlock.boundingBox === "block") {
				bot.entity.onGround = true;
			}

			this.lastSent.x = bot.entity.position.x;
			this.lastSent.y = bot.entity.position.y;
			this.lastSent.z = bot.entity.position.z;
			this.lastSent.yaw = Math.fround(toNotchianYaw(bot.entity.yaw));
			this.lastSent.pitch = Math.fround(toNotchianPitch(bot.entity.pitch));
			this.lastSent.onGround = bot.entity.onGround;
			this.lastSent.time = performance.now();
			this.lastTeleportTick = this.tickCount;

			// When a proxy client is connected, they handle movement themselves — don't
			// send a bot position_look that would conflict with the client's own packets.
			// Sprint/sneak trackers are left alone too: the client owns the wire, its
			// entity_action packets are tracked by ServerClient, and detach() syncs the
			// trackers from that. Flipping them here poisoned the handover whenever the
			// session ended right after a teleport (e.g. a pearl) with no movement after.
			if (MinecraftClient.proxy?.connected) return;

			this.rawWrite("position_look", {
				x: bot.entity.position.x,
				y: bot.entity.position.y,
				z: bot.entity.position.z,
				yaw: this.lastSent.yaw,
				pitch: this.lastSent.pitch,
				onGround: bot.entity.onGround
			});

			// Deliberately NO sprint/sneak resync here. Teleports don't reset action state on
			// the server or in the anticheat's packet-derived model — only respawns do (handled
			// on the respawn event). The old tracker flip here re-sent startSprint/stopSneak
			// after EVERY correction, and since a duplicate status transition is itself a
			// violation, one correction became a self-sustaining loop: correction → duplicate
			// edges → flag+setback → correction, at exactly one correction per tick, forever.
			// That loop WAS the "bot can't walk, constant rubberband" failure mode.
		});

		// Handle knockback from explosions
		bot._client.on("explosion", (packet: { playerMotionX?: number; playerMotionY?: number; playerMotionZ?: number }) => {
			if (packet.playerMotionX !== null && packet.playerMotionX !== undefined) {
				bot.entity.velocity.x += packet.playerMotionX;
				bot.entity.velocity.y += packet.playerMotionY!;
				bot.entity.velocity.z += packet.playerMotionZ!;
			}
		});

		// Knockback/push applied to our player entity. Mineflayer already mirrors it into
		// bot.entity.velocity (entities.js), which is all a vanilla client does.
		//
		// This handler used to force a sprint/sneak "resync" here on the theory that the
		// server resets sprint when an entity takes damage — but that reset applies to the
		// ATTACKER (vanilla's attack sprint reset), not the victim, so the re-sent edge was
		// a duplicate status transition. Worse, self-velocity isn't rare: standing in an
		// entity-dense area the server pushes the player dozens of times per second, and the
		// flip turned each one into a spurious sprint/sneak edge on the wire — churning the
		// anticheat's packet-derived sprint state against our simulation every single tick,
		// which is a permanent speed misprediction. Trace-only now.
		bot._client.on("entity_velocity", (packet: { entityId: number; velocity?: { x: number; y: number; z: number }; velocityX?: number; velocityY?: number; velocityZ?: number }) => {
			if (packet.entityId !== bot.entity?.id) return;

			// Wire units are 1/8000 block per tick; this protocol version nests them.
			const vx = (packet.velocity?.x ?? packet.velocityX ?? 0) / 8000;
			const vy = (packet.velocity?.y ?? packet.velocityY ?? 0) / 8000;
			const vz = (packet.velocity?.z ?? packet.velocityZ ?? 0) / 8000;

			// Remember it: if a correction lands before the next simulation step, mineflayer's
			// teleport handling zeroes entity velocity and would erase this knockback — but the
			// server expects it applied (its position runs ahead of ours in the push direction
			// when we drop these). forcedMove restores it while fresh.
			this.pendingKnockback = { x: vx, y: vy, z: vz, time: performance.now() };
		});

		// Item-use state, straight from the server. The living-entity flags byte is broadcast to
		// us for our own entity, and bit 0x01 is exactly "this player is using an item" — the
		// same bit the server drives its own movement slowdown from. Everything else (mineflayer's
		// bot.usingHeldItem, our own optimistic flag) is a local guess that can silently disagree
		// with the server; this cannot.
		bot._client.on("entity_metadata", (packet: { entityId: number; metadata: { key: number; value: unknown }[] }) => {
			if (!bot.entity || packet.entityId !== bot.entity.id) return;
			for (const entry of packet.metadata) {
				if (entry.key !== META_LIVING_FLAGS) continue;

				const using = ((entry.value as number) & 0x01) !== 0;

				// Falling edge *after* the server had picked the use up: it is finished or was
				// interrupted, so drop our own flag too. Without this the optimistic flag would
				// latch on for a use the server has already ended, and every subsequent tick
				// would simulate at item-use speed while nothing was actually being used —
				// which is exactly what "walks at eating pace but never eats" looked like.
				if (this.serverUsingItem && !using) this.usingItemLocal = false;

				this.serverUsingItem = using;
				break;
			}
		});

		// Status 9 is the server telling us the use ended (finished, or interrupted).
		bot._client.on("entity_status", (packet: { entityId: number; entityStatus: number }) => {
			if (!bot.entity || packet.entityId !== bot.entity.id) return;
			if (packet.entityStatus !== 9) return;
			this.serverUsingItem = false;
			this.usingItemLocal = false;
		});

		// Mineflayer's attribute handler reads `prop.key`, but this protocol version names the
		// field `prop.name` — so every attribute collapses under the single key `undefined` and
		// prismarine-physics never sees the server's movement-speed attribute or its modifiers
		// (Speed II from the base beacons, the sprint modifier). The physics then simulates at
		// unmodified base speed: legal (slower than the server's max is always accepted) but
		// wrong, and blind to any slowing modifier the server might apply. Re-file them under
		// their real names; this listener runs after mineflayer's, so the fixed keys win.
		bot._client.on("entity_update_attributes", (packet: { entityId: number; properties?: { name?: string; key?: string; value: number; modifiers: unknown[] }[] }) => {
			if (!bot.entity || packet.entityId !== bot.entity.id || !packet.properties) return;
			const entity = bot.entity as unknown as { attributes?: Record<string, { value: number; modifiers: unknown[] }> };
			entity.attributes ??= {};
			delete entity.attributes.undefined;
			for (const prop of packet.properties) {
				const key = prop.name ?? prop.key;
				if (key === undefined) continue;
				entity.attributes[key] = { value: prop.value, modifiers: prop.modifiers };
			}
		});

		// Respawning clears any in-flight use on both sides. It is also the one event that
		// genuinely resets action state: the server spawns a fresh player entity with sprint
		// and sneak off, and the anticheat's packet-state model resets with it. Mirroring that
		// here means the next tick emits a legitimate single start edge if we intend to sprint.
		bot.on("respawn", () => {
			this.serverUsingItem = false;
			this.usingItemLocal = false;
			this.lastSprint = false;
			this.lastSneak = false;
		});

		// Defer engine creation + tick loop until the bot is in-game with version and world ready
		// Must wait until AFTER queue — in the queue lobby (0.5, 64, 0.5) there are no chunks,
		// so physics simulation produces NaN positions immediately.
		const init = () => {
			this.engine = Physics(mcData(bot.version), bot.world);
			this.smoothYaw = bot.entity?.yaw ?? 0;
			this.smoothPitch = bot.entity?.pitch ?? 0;
			this.rotation.reset();

			this.reportProtocolVersion();

			// Send initial sprint/sneak state so the server matches our defaults
			this.rawWrite("entity_action", { entityId: bot.entity.id, actionId: 4, jumpBoost: 0 }); // stop sprint
			this.rawWrite("entity_action", { entityId: bot.entity.id, actionId: 1, jumpBoost: 0 }); // stop sneak

			this.start();
		};

		const afterQueue = () => {
			if (MinecraftClient.queue?.isQueued) {
				MinecraftClient.queue.once("leave-queue", () => bot.once("spawn", init));
			} else {
				init();
			}
		};

		if (bot.game) {
			afterQueue();
		} else {
			bot.once("login", afterQueue);
		}
	}

	/**
	 * Run one tick of physics simulation (called every 50ms / 20 tps)
	 */

	private tick() {
		if (!this.engine || !this.bot.entity) return;

		this.tickCount++;
		this.rotation.onTick();

		// When a player is controlling the bot via proxy, their client handles
		// physics and sends movement packets directly to the server. Our simulation
		// must NOT run — it would overwrite bot.entity.position with stale values,
		// causing desync between what 2b2t knows and what we replay on reconnect.
		if (MinecraftClient.proxy?.connected) {

			// Modules still need to tick (KillAura, AntiAFK, etc.) — they observe
			// state and emit their own packets independently of the physics sim.
			for (const fn of this.onPreTick) fn();
			return;
		}

		// Sanitize position: NaN entering tick — something external corrupted position
		if (isNaN(this.bot.entity.position.x) || isNaN(this.bot.entity.position.y) || isNaN(this.bot.entity.position.z)) {
			this.bot.entity.position.set(this.lastSent.x, this.lastSent.y, this.lastSent.z);
			this.bot.entity.velocity.set(0, 0, 0);
		}

		// Sanitize velocity: NaN velocity causes the entire simulation to produce NaN
		// (queryBB.extend with NaN → getSurroundingBBs returns nothing → playerBB offset by NaN → NaN pos)
		const vel = this.bot.entity.velocity;
		if (isNaN(vel.x) || isNaN(vel.y) || isNaN(vel.z)) {
			vel.set(0, 0, 0);
		}

		for (const fn of this.onPreTick) fn();

		this.tickItemUseWatchdog();

		// Send sprint/sneak entity_action packets when controls change
		this.syncActionPackets();

		// Use the desired yaw/pitch directly — no rate limiting.
		// Vanilla servers and Grim accept any yaw change per tick; rate limiting
		// only existed in mineflayer for smooth client-side rendering.
		this.smoothYaw = this.bot.entity.yaw;
		this.smoothPitch = this.bot.entity.pitch;

		// The wire yaw is the wrapped local yaw re-expressed on the server's revolution — see
		// toWireYaw. Computed before simulation so the sim runs with the exact value sent.
		const wireYaw = this.toWireYaw(toNotchianYaw(this.smoothYaw));
		const wirePitch = Math.fround(toNotchianPitch(this.smoothPitch));

		// Quantize to float32 (via Notchian degree conversion) and convert back.
		// This ensures our physics simulation uses the EXACT same yaw/pitch the server will receive,
		// eliminating float64→float32 drift that causes position mismatches with Grim.
		this.bot.entity.yaw = fromNotchianYaw(wireYaw);
		this.bot.entity.pitch = fromNotchianPitch(wirePitch);

		// Create a controls snapshot for physics simulation.
		// When using an item (eating/drinking), the server applies 0.2x movement input
		// and cancels sprint (LivingEntity.livingEntityTick). Mirror that here so our
		// simulated positions match the server and avoid correction loops.
		let physControls: Controls = this.controls;
		if (this.isUsingItem) {
			const USE_ITEM_SPEED = 0.2 as unknown as boolean;
			physControls = {
				...this.controls,
				sprint: false,
				forward: this.controls.forward ? USE_ITEM_SPEED : false,
				back: this.controls.back ? USE_ITEM_SPEED : false,
				left: this.controls.left ? USE_ITEM_SPEED : false,
				right: this.controls.right ? USE_ITEM_SPEED : false
			};
		} else if (this.controls.sprint && !this.sprintAllowed) {

			// The wire never asserted sprint (syncActionPackets gates on the same condition),
			// so the simulation must not run at sprint speed either.
			physControls = { ...this.controls, sprint: false };
		}

		// Grim resimulates the tick after a teleport ack from a freshly-reset state; jumping in
		// that exact tick reliably mispredicts and triggers the next setback. With the pathfinder
		// holding jump against an obstacle that becomes a permanent setback loop. Hackware gates
		// jump input the same way (ClientInputMixin, justTeleported(1)).
		if (this.tickCount - this.lastTeleportTick <= 1 && physControls.jump) {
			physControls = { ...physControls, jump: false };
		}

		// Entity crowding pushes — must happen before simulation so the claimed movement
		// reflects them. See applyEntityPushes for why this is load-bearing.
		this.applyEntityPushes();

		// Create player state from the bot, simulate one tick, and apply the result back
		const state = new PlayerState(this.bot, physControls);

		this.engine.simulatePlayer(state, this.bot.world);

		// NaN produced by simulation — don't apply
		if (isNaN(state.pos.x) || isNaN(state.pos.y) || isNaN(state.pos.z)) {
			return;
		}

		state.apply(this.bot);

		// The pending knockback (if any) has now been through a simulation step — consumed.
		this.pendingKnockback = null;

		// Only send position updates when no player is controlling via proxy
		if (!MinecraftClient.proxy?.connected) {
			this.updatePosition(performance.now(), wireYaw, wirePitch);
		}
	}

	/**
	 * Send entity_action packets when sprint/sneak controls change, so the server
	 * knows the player's action state and can predict movement speed correctly.
	 */
	private syncActionPackets() {

		// While using an item (eating/drinking), the server cancels sprint each tick
		// in LivingEntity.livingEntityTick(). Actively send sprint_stop so the server
		// and our physics agree, and suppress sprint_start until item use ends.
		if (this.isUsingItem) {
			if (this.lastSprint) {
				this.lastSprint = false;
				this.bot._client.write("entity_action", {
					entityId: this.bot.entity.id,
					actionId: 4, // sprint_stop
					jumpBoost: 0
				});
			}
		} else {
			const wantSprint = this.controls.sprint && this.sprintAllowed;
			if (wantSprint !== this.lastSprint) {
				this.lastSprint = wantSprint;
				this.bot._client.write("entity_action", {
					entityId: this.bot.entity.id,
					actionId: wantSprint ? 3 : 4,
					jumpBoost: 0
				});
			}
		}

		if (this.controls.sneak !== this.lastSneak) {
			this.lastSneak = this.controls.sneak;
			this.bot._client.write("entity_action", {
				entityId: this.bot.entity.id,
				actionId: this.controls.sneak ? 0 : 1,
				jumpBoost: 0
			});
		}
	}

	/**
	 * Send position/look updates matching mineflayer's updatePosition logic:
	 * - Only send the packet type needed (position, look, or both)
	 * - `yaw`/`pitch` are the float32-quantized wire angles computed in {@link tick} — the same
	 *   values the physics simulation ran with, with yaw already on the server's revolution
	 *
	 * Uses this.rawWrite to bypass the movement-packet suppression filter.
	 */
	private updatePosition(now: number, yaw: number, pitch: number) {
		if (!Number.isFinite(this.bot.entity.position.x)) return;

		const position = this.bot.entity.position;
		const onGround = this.bot.entity.onGround;

		const positionUpdated =
			this.lastSent.x !== position.x ||
			this.lastSent.y !== position.y ||
			this.lastSent.z !== position.z ||
			(Math.round((now - this.lastSent.time) / PHYSICS_INTERVAL_MS) * PHYSICS_INTERVAL_MS) >= 1000;
		const lookUpdated = this.lastSent.yaw !== yaw || this.lastSent.pitch !== pitch;

		if (positionUpdated && lookUpdated) {
			this.lastSent.x = position.x;
			this.lastSent.y = position.y;
			this.lastSent.z = position.z;
			this.lastSent.yaw = yaw;
			this.lastSent.pitch = pitch;
			this.lastSent.onGround = onGround;
			this.lastSent.time = now;
			this.rawWrite("position_look", {
				x: position.x, y: position.y, z: position.z,
				yaw, pitch, onGround
			});
		} else if (positionUpdated) {
			this.lastSent.x = position.x;
			this.lastSent.y = position.y;
			this.lastSent.z = position.z;
			this.lastSent.onGround = onGround;
			this.lastSent.time = now;
			this.rawWrite("position", {
				x: position.x, y: position.y, z: position.z, onGround
			});
		} else if (lookUpdated) {
			this.lastSent.yaw = yaw;
			this.lastSent.pitch = pitch;
			this.lastSent.onGround = onGround;
			this.rawWrite("look", { yaw, pitch, onGround });
		} else if (onGround !== this.lastSent.onGround) {
			this.rawWrite("flying", { onGround });
		}

		this.lastSent.onGround = onGround;
	}

	/**
	 * Vanilla's entity crowding pushes (`LivingEntity.pushEntities` / `Entity.push`), ported.
	 *
	 * The server pushes a player standing inside other entities' hitboxes every tick, and the
	 * anticheat simulates those pushes from its own entity tracker — so a client that doesn't
	 * apply them mispredicts every tick it spends in a crowd. Worse, the resulting corrections
	 * zero our velocity (vanilla teleport semantics), wiping the server's knockback packets
	 * before the sim can use them: without locally regenerating the push from entity overlap
	 * each tick, one crowd contact becomes a correction storm that pins the bot in place.
	 *
	 * Pushable set per vanilla: living entities and players (not armor stands, not shulkers,
	 * which override isPushable to false), plus boats and minecarts.
	 */
	private applyEntityPushes() {
		const self = this.bot.entity;
		if (!self) return;

		// Player AABB: 0.6 × 1.8, unexpanded — vanilla selects intersecting entities only.
		const selfHalf = 0.3;
		const selfHeight = 1.8;
		const pos = self.position;

		for (const entity of Object.values(this.bot.entities)) {

			// isValid is only ever assigned on destroy (entities.js sets it false) — a live
			// entity may not have the property at all, so test for the explicit false.
			if (entity === self || entity.isValid === false) continue;

			const pushable =
				entity.type === "player" ||
				(entity.type === "mob" && entity.name !== "armor_stand" && entity.name !== "shulker") ||
				(entity.name !== undefined && (entity.name.includes("boat") || entity.name.includes("minecart")));
			if (!pushable) continue;

			const half = (entity.width ?? 0.6) / 2;
			const height = entity.height ?? 1.8;
			const intersects =
				entity.position.x + half > pos.x - selfHalf && entity.position.x - half < pos.x + selfHalf &&
				entity.position.z + half > pos.z - selfHalf && entity.position.z - half < pos.z + selfHalf &&
				entity.position.y + height > pos.y && entity.position.y < pos.y + selfHeight;
			if (!intersects) continue;

			// Entity.push: normalize the XZ offset by sqrt(absMax), cap the 1/d falloff at 1,
			// scale by 0.05, and push ourselves away. (The reciprocal push on the other entity
			// is the server's business.)
			let dx = entity.position.x - pos.x;
			let dz = entity.position.z - pos.z;
			let d = Math.max(Math.abs(dx), Math.abs(dz));
			if (d < 0.01) continue;
			d = Math.sqrt(d);
			dx /= d;
			dz /= d;
			const falloff = Math.min(1, 1 / d);
			self.velocity.x -= dx * falloff * 0.05;
			self.velocity.z -= dz * falloff * 0.05;
		}
	}

	/**
	 * Express an outgoing yaw on the same revolution as the last yaw the server saw.
	 *
	 * A vanilla client's sent yaw is continuous — it accumulates across full turns and never
	 * wraps. Every local yaw source here is wrapped (`atan2` steering, the float32 round-trip's
	 * normalization, AntiAFK's spin), so crossing the ±180° boundary would otherwise put a raw
	 * ~360° delta in a single packet — a jump no real client can produce, and exactly the pattern
	 * Grim's `AimModulo360` keys on. Mineflayer's updatePosition avoided this with its accumulated
	 * `lastSentYaw`; removing the rotation rate-limit dropped that accumulation, so re-anchor at
	 * the wire instead, the same way {@link RotationManager} anchors silent looks.
	 *
	 * Same-revolution values pass through verbatim so a steady rotation stays bit-identical
	 * tick to tick. The anchor resets whenever the server overwrites our rotation (teleports),
	 * matching vanilla.
	 */
	private toWireYaw(rawDegrees: number): number {
		const raw = Math.fround(rawDegrees);
		const anchor = this.lastSent.yaw;
		if (Math.abs(raw - anchor) <= 180) return raw;
		return Math.fround(anchor + wrapDegrees(raw - anchor));
	}

	/**
	 * Send one extra `position_look` carrying a spoofed rotation and the last position we sent,
	 * verbatim. Called by {@link RotationManager} — see there for why the duplicated position
	 * matters.
	 *
	 * `lastSent` is advanced to the spoofed angles on purpose: the next tick's change detection
	 * then sees a rotation mismatch and re-asserts the real rotation on that tick's normal
	 * movement packet. Without it, a bot holding a steady rotation would send position-only
	 * packets forever and the server would keep simulating us with the spoofed angle.
	 */
	public writeSilentLook(yaw: number, pitch: number) {
		this.rawWrite("position_look", {
			x: this.lastSent.x,
			y: this.lastSent.y,
			z: this.lastSent.z,
			yaw,
			pitch,
			onGround: this.lastSent.onGround
		});
		this.lastSent.yaw = yaw;
		this.lastSent.pitch = pitch;
	}

	/**
	 * Adopt the wire state a proxied client established, so the resumed simulation starts
	 * from what the server actually believes instead of the stale pre-session snapshot.
	 *
	 * `yaw`/`pitch` are Notchian degrees as seen on the wire. Sprint/sneak are handed over
	 * separately via {@link syncWireActions}, which must happen even when this is skipped.
	 */
	public resumeFromProxy(state: {
		x: number; y: number; z: number;
		yaw: number; pitch: number;
		onGround: boolean;
	}) {
		const entity = this.bot.entity;
		if (entity) {
			entity.position.set(state.x, state.y, state.z);
			entity.velocity.set(0, 0, 0);
			entity.yaw = fromNotchianYaw(Math.fround(state.yaw));
			entity.pitch = fromNotchianPitch(Math.fround(state.pitch));
			entity.onGround = state.onGround;
			this.smoothYaw = entity.yaw;
			this.smoothPitch = entity.pitch;
		}

		this.lastSent.x = state.x;
		this.lastSent.y = state.y;
		this.lastSent.z = state.z;
		this.lastSent.yaw = Math.fround(state.yaw);
		this.lastSent.pitch = Math.fround(state.pitch);
		this.lastSent.onGround = state.onGround;
		this.lastSent.time = performance.now();
	}

	/**
	 * Adopt the sprint/sneak wire state a proxied client's `entity_action` packets established.
	 *
	 * The anticheat's sprint state is packet-derived, so the client's last transition is the
	 * truth regardless of anything the server did internally — and a mismatch never self-heals:
	 * no packet ever corrects it, so the simulation mispredicts speed every tick forever.
	 */
	public syncWireActions(sprint: boolean, sneak: boolean) {
		this.lastSprint = sprint;
		this.lastSneak = sneak;
	}

	/**
	 * Confirm a teleport the proxied client received but never acknowledged (it disconnected
	 * first). Mineflayer's own confirm is suppressed while a client is attached, so without
	 * this the server would be left waiting and kick on the bot's next movement packet.
	 */
	public confirmTeleport(teleportId: number) {
		this.rawWrite("teleport_confirm", { teleportId });
	}

	/**
	 * Answer a play `ping` the proxied client received but never answered (it disconnected
	 * first). Mineflayer's auto-pong is suppressed while a client is attached, so without this
	 * the anticheat's transaction chain would be left with a hole at handover.
	 */
	public answerPing(id: number) {
		this.rawWrite("pong", { id });
	}

	// ─── Sprint wire state ───────────────────────────────────────

	/** Whether the server currently believes we are sprinting. */
	public get sprintingOnWire(): boolean {
		return this.lastSprint;
	}

	/**
	 * Vanilla's client-side sprint gate: a real client refuses to start or continue sprinting
	 * at 6 food or below, and the anticheat emulates the client — sprint packets and sprint
	 * speed while hungry are both non-vanilla. Without this gate the bot sprints illegally the
	 * moment food runs low and mispredicts every tick until it eats, which presents as a
	 * permanent rubberband that starts "after a few minutes" of walking.
	 */
	private get sprintAllowed(): boolean {
		const food = this.bot.food;
		return typeof food === "number" ? food > 6 : true;
	}

	/**
	 * Drop sprint on the wire, if it is up.
	 *
	 * Only ever transition a state the server is not already in — a redundant sprint packet is a
	 * duplicate status change, which is its own flag. This is why nothing outside this class may
	 * write sprint `entity_action`s directly: two trackers drift apart and every subsequent
	 * assertion becomes a duplicate.
	 * @returns whether a packet was sent (and therefore whether a restore is owed)
	 */
	public dropSprint(): boolean {
		if (!this.lastSprint) return false;
		this.lastSprint = false;
		this.bot._client.write("entity_action", {
			entityId: this.bot.entity.id,
			actionId: 4, // stop_sprinting
			jumpBoost: 0
		});
		return true;
	}

	/** Re-assert sprint after a {@link dropSprint}, if we still intend to be sprinting. */
	public restoreSprint(): boolean {
		if (this.lastSprint) return false;
		if (!this.controls.sprint) return false;
		if (!this.sprintAllowed) return false;

		// The server drops sprint for the duration of an item use anyway; re-asserting it here
		// would be a transition it immediately undoes.
		if (this.isUsingItem) return false;

		this.lastSprint = true;
		this.bot._client.write("entity_action", {
			entityId: this.bot.entity.id,
			actionId: 3, // start_sprinting
			jumpBoost: 0
		});
		return true;
	}

	/**
	 * Run `fn` with sprint dropped on the wire, restoring afterwards.
	 *
	 * Container clicks that arrive while the server thinks we are sprinting are flagged *and
	 * cancelled* by the anticheat, so a swap performed while running simply never happens. The
	 * drop, the click and the restore are ordered on the wire, which is all that matters — `fn`
	 * may return a promise that resolves later, as long as it writes its packet synchronously.
	 */
	public withSprintDropped<T>(fn: () => T): T {
		const dropped = this.dropSprint();
		try {
			return fn();
		} finally {
			if (dropped) this.restoreSprint();
		}
	}

	// ─── Diagnostics ─────────────────────────────────────────────

	/**
	 * Warn if we ever present as 1.21 or newer.
	 *
	 * Silent rotations are only free because the anticheat exempts a movement packet that repeats
	 * the previous position from both its tick-rate accounting and its movement prediction — and
	 * that exemption only exists for clients below 1.21. Above it, every silent look becomes a
	 * counted, simulated, zero-movement tick.
	 */
	private reportProtocolVersion() {
		const version = this.bot.version;
		const [ major, minor ] = version.split(".").map(part => parseInt(part, 10));
		const below121 = major !== undefined && minor !== undefined && (major < 1 || (major === 1 && minor < 21));

		if (below121) {
			PhysicsManager.logger.log(`Protocol ${ chalk.cyan(version) } — silent-rotation duplicate exemption ${ chalk.green("active") }`);
		} else {
			PhysicsManager.logger.warn(`Protocol ${ chalk.cyan(version) } is 1.21+ — silent-rotation duplicate exemption is ${ chalk.red("dead") }, every silent look will be counted and simulated`);
		}
	}

	private start() {
		if (this.interval) return;
		this.interval = setInterval(() => this.tick(), 50);
	}

	public stop() {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

}
