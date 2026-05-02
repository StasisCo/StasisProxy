import mcData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Physics, PlayerState, type Controls } from "prismarine-physics";
import { Client } from "~/class/Client";

const PI = Math.PI;
const PI_2 = Math.PI * 2;
const TO_DEG = 180 / PI;
const TO_RAD = PI / 180;
const PHYSICS_INTERVAL_MS = 50;

type LookTarget = { x: number; y: number; z: number };

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

	private engine: ReturnType<typeof Physics> | null = null;

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
	 * Reliable item-use flag set by modules (AutoEat etc.).
	 * Unlike bot.usingHeldItem, this is not affected by mineflayer's entity_status bug
	 * (which clears usingHeldItem on ANY entity_status packet) or by heldItemChanged /
	 * set_cooldown events that can fire spuriously on busy servers.
	 */
	public isUsingItem = false;

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

	constructor(private readonly bot: Bot) {

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
			if (Client.proxy?.connected) {

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

		// Fix mineflayer bug: inventory.js entity_status handler sets bot.usingHeldItem = false
		// for EVERY entity_status packet, regardless of entity ID or status code.
		// On busy servers like 2b2t, hurt animations from any entity constantly reset this flag,
		// breaking our item-use speed guards and sprint suppression during eating.
		// Use prependListener to snapshot the value BEFORE mineflayer's handler clears it,
		// then a post-listener to restore it when the clear was spurious.
		let wasUsingHeldItem = false;
		bot._client.prependListener("entity_status", () => {
			wasUsingHeldItem = bot.usingHeldItem;
		});
		bot._client.on("entity_status", (packet: { entityId: number; entityStatus: number }) => {
			if (wasUsingHeldItem && !(packet.entityId === bot.entity?.id && packet.entityStatus === 9)) {
				bot.usingHeldItem = true;
			}
		});

		// Fix mineflayer bug: heldItemChanged handler clears usingHeldItem when any set_slot
		// or window_items packet updates the inventory, even if the held item hasn't meaningfully
		// changed. On busy servers, redundant slot updates reset the flag during eating.
		let wasUsingHeldItemHeld = false;
		(bot as unknown as NodeJS.EventEmitter).prependListener("heldItemChanged", () => {
			wasUsingHeldItemHeld = bot.usingHeldItem;
		});
		(bot as unknown as NodeJS.EventEmitter).on("heldItemChanged", () => {
			if (wasUsingHeldItemHeld) {
				bot.usingHeldItem = true;
			}
		});

		// Fix mineflayer bug: set_cooldown handler clears usingHeldItem unconditionally.
		let wasUsingHeldItemCd = false;
		bot._client.prependListener("set_cooldown", () => {
			wasUsingHeldItemCd = bot.usingHeldItem;
		});
		bot._client.on("set_cooldown", () => {
			if (wasUsingHeldItemCd) {
				bot.usingHeldItem = true;
			}
		});

		// Defer engine creation + tick loop until the bot is in-game with version and world ready
		// Must wait until AFTER queue — in the queue lobby (0.5, 64, 0.5) there are no chunks,
		// so physics simulation produces NaN positions immediately.
		const init = () => {
			this.engine = Physics(mcData(bot.version), bot.world);
			this.smoothYaw = bot.entity?.yaw ?? 0;
			this.smoothPitch = bot.entity?.pitch ?? 0;

			// Send initial sprint/sneak state so the server matches our defaults
			this.rawWrite("entity_action", { entityId: bot.entity.id, actionId: 4, jumpBoost: 0 }); // stop sprint
			this.rawWrite("entity_action", { entityId: bot.entity.id, actionId: 1, jumpBoost: 0 }); // stop sneak

			this.start();
		};

		const afterQueue = () => {
			if (Client.queue?.isQueued) {
				Client.queue.once("leave-queue", () => bot.once("spawn", init));
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

		// When a player is controlling the bot via proxy, their client handles
		// physics and sends movement packets directly to the server. Our simulation
		// must NOT run — it would overwrite bot.entity.position with stale values,
		// causing desync between what 2b2t knows and what we replay on reconnect.
		if (Client.proxy?.connected) {

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

		// Sync isUsingItem from mineflayer's flag
		this.isUsingItem = this.bot.usingHeldItem;

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
		if (!Client.proxy?.connected) {
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
	 * Force-send a look packet to the server immediately.
	 * Used by modules that need the server to have the correct pitch/yaw
	 * BEFORE a subsequent packet (e.g. use_item) in the same tick.
	 */
	public sendLook(target: LookTarget): void;
	public sendLook(yaw: number, pitch: number): void;
	public sendLook(targetOrYaw: LookTarget | number, pitch?: number) {
		let yaw: number;
		let resolvedPitch: number;

		if (typeof targetOrYaw === "number") {
			yaw = targetOrYaw;
			resolvedPitch = pitch ?? this.bot.entity.pitch;
		} else {
			const eye = this.bot.entity.position.offset(0, this.bot.entity.height, 0);
			const dx = targetOrYaw.x - eye.x;
			const dy = targetOrYaw.y - eye.y;
			const dz = targetOrYaw.z - eye.z;
			const xz = Math.sqrt(dx * dx + dz * dz);

			yaw = Math.atan2(-dx, -dz);
			resolvedPitch = Math.atan2(dy, xz);
		}

		this.bot.entity.yaw = yaw;
		this.bot.entity.pitch = resolvedPitch;

		const notchYaw = Math.fround(toNotchianYaw(yaw));
		const notchPitch = Math.fround(toNotchianPitch(resolvedPitch));
		const onGround = this.bot.entity.onGround;

		this.lastSent.yaw = notchYaw;
		this.lastSent.pitch = notchPitch;
		this.rawWrite("look", { yaw: notchYaw, pitch: notchPitch, onGround });
	}

	/** Install a property trap on bot.entity to catch position being replaced with NaN */
	// Removed — NaN diagnostics no longer needed. Root cause was NaN velocity from mineflayer;
	// now sanitized at tick start.

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
