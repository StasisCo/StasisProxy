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

	/** Rate-limited yaw/pitch — these are what physics simulates with AND what gets sent */
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

	constructor(public readonly bot: Bot) {

		this.rotation = new RotationManager(this);

		// Intercept bot._client.write to suppress mineflayer's outgoing movement packets.
		this.rawWrite = bot._client.write.bind(bot._client);
		const origWrite = this.rawWrite;
		bot._client.write = function(name: string, data: unknown) {
			if (MOVEMENT_PACKETS.has(name)) return;
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

			// When a proxy client is connected, they handle movement themselves — don't
			// send a bot position_look that would conflict with the client's own packets.
			if (MinecraftClient.proxy?.connected) {

				// Still resync sprint/sneak in case the server reset action state
				this.lastSprint = !this.controls.sprint;
				this.lastSneak = !this.controls.sneak;
				return;
			}

			this.rawWrite("position_look", {
				x: bot.entity.position.x,
				y: bot.entity.position.y,
				z: bot.entity.position.z,
				yaw: this.lastSent.yaw,
				pitch: this.lastSent.pitch,
				onGround: bot.entity.onGround
			});

			// Force resync sprint/sneak state — the server may reset action state on teleport
			this.lastSprint = !this.controls.sprint;
			this.lastSneak = !this.controls.sneak;
		});

		// Handle knockback from explosions
		bot._client.on("explosion", (packet: { playerMotionX?: number; playerMotionY?: number; playerMotionZ?: number }) => {
			if (packet.playerMotionX !== null && packet.playerMotionX !== undefined) {
				bot.entity.velocity.x += packet.playerMotionX;
				bot.entity.velocity.y += packet.playerMotionY!;
				bot.entity.velocity.z += packet.playerMotionZ!;
			}
		});

		// Handle knockback from damage (entity_velocity targeting our entity).
		// The server calls setSprinting(false) when an entity takes damage, creating
		// a desync: our physics simulates at sprint speed while the server expects walk
		// speed. Force-resync sprint/sneak so the server knows our intended action state.
		bot._client.on("entity_velocity", (packet: { entityId: number }) => {
			if (packet.entityId !== bot.entity?.id) return;
			this.lastSprint = !this.controls.sprint;
			this.lastSneak = !this.controls.sneak;
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

		// Respawning clears any in-flight use on both sides.
		bot.on("respawn", () => {
			this.serverUsingItem = false;
			this.usingItemLocal = false;
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

		// Quantize to float32 (via Notchian degree conversion) and convert back.
		// This ensures our physics simulation uses the EXACT same yaw/pitch the server will receive,
		// eliminating float64→float32 drift that causes position mismatches with Grim.
		const notchYaw = Math.fround(toNotchianYaw(this.smoothYaw));
		const notchPitch = Math.fround(toNotchianPitch(this.smoothPitch));
		this.bot.entity.yaw = fromNotchianYaw(notchYaw);
		this.bot.entity.pitch = fromNotchianPitch(notchPitch);

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
		}

		// Create player state from the bot, simulate one tick, and apply the result back
		const state = new PlayerState(this.bot, physControls);

		this.engine.simulatePlayer(state, this.bot.world);

		// NaN produced by simulation — don't apply
		if (isNaN(state.pos.x) || isNaN(state.pos.y) || isNaN(state.pos.z)) {
			return;
		}

		state.apply(this.bot);

		// Only send position updates when no player is controlling via proxy
		if (!MinecraftClient.proxy?.connected) {
			this.updatePosition(performance.now());
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
		} else if (this.controls.sprint !== this.lastSprint) {
			this.lastSprint = this.controls.sprint;
			this.bot._client.write("entity_action", {
				entityId: this.bot.entity.id,
				actionId: this.controls.sprint ? 3 : 4,
				jumpBoost: 0
			});
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
	 * - Rate-limit yaw/pitch changes to match vanilla turn speed
	 * - Use Math.fround() for 32-bit float precision
	 * - Only send the packet type needed (position, look, or both)
	 *
	 * Uses this.rawWrite to bypass the movement-packet suppression filter.
	 */
	private updatePosition(now: number) {
		if (!Number.isFinite(this.bot.entity.position.x)) return;

		// Yaw/pitch are already rate-limited and quantized before simulation — send them directly
		const yaw = Math.fround(toNotchianYaw(this.smoothYaw));
		const pitch = Math.fround(toNotchianPitch(this.smoothPitch));
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

	// ─── Sprint wire state ───────────────────────────────────────

	/** Whether the server currently believes we are sprinting. */
	public get sprintingOnWire(): boolean {
		return this.lastSprint;
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
