import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { Goal } from "../class/Goal";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";

export class PathfindingManager {

	private queue: Goal[] = [];
	private active: Goal | null = null;
	private home: Vec3 | null = null;
	private returningHome = false;

	/** True while awaiting async onArrived/onTimeout listeners — blocks premature processNext and returnHome */
	private finishing = false;

	/** Tracks ticks spent without meaningful XZ movement while controls.forward is true */
	private stuckTicks = 0;
	private lastPos = { x: 0, z: 0 };

	/** Watchdog: best (closest) distance to target seen this goal, and ticks since it improved. */
	private bestDistance = Infinity;
	private ticksSinceProgress = 0;

	/** When dodging, commit to a chosen yaw for this many ticks before reconsidering */
	private dodgeYaw: number | null = null;
	private dodgeTicksRemaining = 0;

	constructor(private readonly bot: Bot) {
		const init = () => {
			MinecraftClient.physics.onPreTick.push(() => this.update());
		};

		const afterQueue = () => {
			if (MinecraftClient.queue?.isQueued) {
				MinecraftClient.queue.once("leave-queue", () => bot.once("spawn", init));
			} else {
				init();
			}
		};

		if (bot.game) afterQueue();
		else bot.once("login", afterQueue);

		bot.on("spawn", () => {
			const pos = this.bot.entity.position.floored();
			this.home = pos.offset(0.5, 0, 0.5) as Vec3;
		});
	}

	public getHome(): Vec3 | null {
		return this.home;
	}

	public setHome(position: Vec3) {
		this.home = position;

		// Cancel stale return-home and navigate to the new position
		if (this.returningHome) {
			if (this.active?._timer) clearTimeout(this.active._timer);
			this.stopMovement();
			this.active = null;
			this.returningHome = false;
		}

		if (!this.active) this.returnHome();
	}

	public pushGoal(goal: Goal): Goal {
		this.queue.push(goal);

		// If we're walking home, cancel it and start the queued goal immediately
		if (this.returningHome) {
			this.returningHome = false;
			if (this.active?._timer) clearTimeout(this.active._timer);
			this.stopMovement();
			this.active = null;
			this.processNext();
		} else if (!this.active && !this.finishing) {
			this.processNext();
		}

		return goal;
	}

	public clear() {
		for (const goal of this.queue) goal.emit("cancelled");
		this.queue = [];
		this.finishActive("cancelled");
	}

	private async processNext() {
		const next = this.queue.shift();
		if (!next) {
			this.returnHome();
			return;
		}
		this.returningHome = false;
		this.startGoal(next);
	}

	private returnHome() {
		if (!this.home || this.returningHome) return;

		// Already at home — stay idle instead of creating a new goal that oscillates
		if (this.bot.entity && this.bot.entity.position.distanceTo(this.home) <= 0.5) return;

		const goal = new Goal(this.home);
		goal.setRange(0.5);
		this.returningHome = true;
		this.startGoal(goal);
	}

	private startGoal(goal: Goal) {
		this.active = goal;
		MinecraftClient.physics.controls.forward = true;
		MinecraftClient.physics.controls.sprint = !this.returningHome;
		this.stuckTicks = 0;
		this.bestDistance = Infinity;
		this.ticksSinceProgress = 0;
		this.dodgeYaw = null;
		this.dodgeTicksRemaining = 0;

		if (goal.timeout !== null) {
			goal._timer = setTimeout(async() => {
				if (this.active === goal) {
					await this.finishActive("timeout");
					this.processNext();
				}
			}, goal.timeout);
		}
	}

	private async finishActive(reason: "arrived" | "timeout" | "cancelled") {
		if (!this.active) return;
		const goal = this.active;
		const wasReturning = this.returningHome;
		if (goal._timer) clearTimeout(goal._timer);
		this.stopMovement();
		this.active = null;
		this.returningHome = false;

		// Home goals have no listeners — skip awaiting
		if (wasReturning) return;

		// Block returnHome and pushGoal→processNext while async listeners run
		this.finishing = true;
		try {

			// Await all listeners so async handlers (interact, remove, etc.) complete
			// before the next goal is started.
			const listeners = goal.listeners(reason);
			await Promise.allSettled(listeners.map(fn => fn()));
		} finally {
			this.finishing = false;
		}
	}

	private stopMovement() {
		MinecraftClient.physics.controls.forward = false;
		MinecraftClient.physics.controls.sprint = false;
		MinecraftClient.physics.controls.jump = false;
	}

	private async update() {
		if (!this.bot.entity) return;

		// Always look straight ahead — prevent pitch getting stuck (e.g. after Stasis.interact() looks at a block below)
		this.bot.entity.pitch = 0;

		// No active goal — check if we've drifted from home and need to return
		if (!this.active) {
			if (!this.finishing && this.home && this.bot.entity.position.distanceTo(this.home) > 1.0) {
				this.returnHome();
			}
			return;
		}

		const pos = this.bot.entity.position;
		const target = this.active.position;
		const distance = pos.distanceTo(target);

		if (distance <= this.active.range) {
			await this.finishActive("arrived");
			this.processNext();
			return;
		}

		// Watchdog: track meaningful progress toward target. If we haven't gotten closer
		// in ~15s (300 ticks), abandon the goal as a timeout so queued goals (home, other
		// stasis activations) can run instead of being stuck behind a dead goal.
		const PROGRESS_THRESHOLD = 0.5;
		const NO_PROGRESS_LIMIT = 300;
		if (distance < this.bestDistance - PROGRESS_THRESHOLD) {
			this.bestDistance = distance;
			this.ticksSinceProgress = 0;
		} else {
			this.ticksSinceProgress++;
			if (this.ticksSinceProgress > NO_PROGRESS_LIMIT) {
				await this.finishActive("timeout");
				this.processNext();
				return;
			}
		}

		// Stuck detection — only count ticks where we're trying to move forward but XZ position
		// isn't changing. Distance to target may not shrink for legitimate reasons (overshoot,
		// jumping, dodging) — that's not the same as being wedged into a wall.
		const movedDist = Math.abs(pos.x - this.lastPos.x) + Math.abs(pos.z - this.lastPos.z);
		if (movedDist > 0.05) {
			this.stuckTicks = 0;
		} else if (MinecraftClient.physics.controls.forward) {
			this.stuckTicks++;
		}
		this.lastPos.x = pos.x;
		this.lastPos.z = pos.z;

		// Steer toward target, avoiding hazards and solid obstacles
		const dx = target.x - pos.x;
		const dz = target.z - pos.z;
		const len = Math.sqrt(dx * dx + dz * dz);

		if (len > 0.01) {

			// While committed to a dodge, hold the yaw rather than re-picking every tick
			if (this.dodgeYaw !== null && this.dodgeTicksRemaining > 0) {
				this.dodgeTicksRemaining--;
				this.bot.entity.yaw = this.dodgeYaw;
				MinecraftClient.physics.controls.forward = true;
			} else {
				const yaw = this.findSafeYaw(pos, dx / len, dz / len);
				if (yaw !== null) {
					this.bot.entity.yaw = yaw;
					MinecraftClient.physics.controls.forward = true;

					// If we picked a non-direct heading because we're stuck, commit to it for ~20 ticks (~1s)
					if (this.stuckTicks > 5) {
						this.dodgeYaw = yaw;
						this.dodgeTicksRemaining = 20;
					}
				} else {

					// All checked directions blocked by hazards — stop
					MinecraftClient.physics.controls.forward = false;
				}
			}
		}

		const entity = this.bot.entity as typeof this.bot.entity & { isCollidedHorizontally?: boolean };

		// Preemptive jump — if there's a 1-high obstacle (solid foot, air head) directly ahead in the
		// current heading, jump now rather than waiting until we're wedged into it.
		const headingX = -Math.sin(this.bot.entity.yaw);
		const headingZ = -Math.cos(this.bot.entity.yaw);
		const aheadX = pos.x + headingX * 0.6;
		const aheadZ = pos.z + headingZ * 0.6;
		const feetBy = Math.floor(pos.y);
		const footAhead = this.bot.blockAt(new Vec3(Math.floor(aheadX), feetBy, Math.floor(aheadZ)));
		const headAhead = this.bot.blockAt(new Vec3(Math.floor(aheadX), feetBy + 1, Math.floor(aheadZ)));
		const oneHighObstacle = footAhead?.boundingBox === "block" && headAhead?.boundingBox !== "block";

		// 2-tall tunnel detection: head-level block is clear but ceiling is exactly 2 blocks above
		// feet. Sprint-jumping continuously in this space is faster than walking.
		const headBlockHere = this.bot.blockAt(new Vec3(Math.floor(pos.x), feetBy + 1, Math.floor(pos.z)));
		const ceilingBlockHere = this.bot.blockAt(new Vec3(Math.floor(pos.x), feetBy + 2, Math.floor(pos.z)));
		const inTwoTallTunnel = headBlockHere?.boundingBox !== "block" && ceilingBlockHere?.boundingBox === "block";

		if (inTwoTallTunnel && MinecraftClient.physics.controls.forward) {
			MinecraftClient.physics.controls.sprint = true;
		}

		MinecraftClient.physics.controls.jump = entity.onGround && (oneHighObstacle || !!entity.isCollidedHorizontally || inTwoTallTunnel);
	}

	/**
	 * Find a yaw that steers toward the target while avoiding dangerous blocks
	 * and solid obstacles. Tries the direct path first, then offsets up to ±90°.
	 * When stuck (no progress for several ticks), expands search to wider angles
	 * and skips the direct path that's clearly not working.
	 */
	private findSafeYaw(pos: { x: number; y: number; z: number }, nx: number, nz: number): number | null {
		const offsets = this.stuckTicks > 10
			? [ 45, -45, 90, -90, 120, -120, 150, -150, 180 ]
			: this.stuckTicks > 5
				? [ 25, -25, 50, -50, 75, -75, 90, -90, 120, -120 ]
				: [ 0, 25, -25, 50, -50, 75, -75, 90, -90 ];
		const feetY = pos.y;
		const by = Math.floor(feetY);

		for (const deg of offsets) {
			const rad = deg * Math.PI / 180;
			const c = Math.cos(rad);
			const s = Math.sin(rad);
			const dirX = nx * c - nz * s;
			const dirZ = nx * s + nz * c;

			const ax = pos.x + dirX;
			const az = pos.z + dirZ;

			if (this.isDangerousBlock(ax, feetY, az) ||
				this.isDangerousBlock(ax, feetY - 1, az)) continue;

			// Check for 2-high solid wall ahead (can't walk through or jump over)
			if (this.isWallAhead(pos.x, by, pos.z, dirX, dirZ)) continue;

			return Math.atan2(-dirX, -dirZ);
		}

		return null;
	}

	/**
	 * Check if there is a 2-high solid wall in the given direction.
	 * Probes multiple distances ahead and offsets perpendicular to the heading
	 * to account for the player's ~0.6-wide hitbox — otherwise a corner block
	 * grazes the shoulder while the center ray reads clear, and we get wedged.
	 * Only flags as blocked when both feet- and head-level cells are solid at
	 * any probed point (1-high obstacles can be jumped).
	 */
	private isWallAhead(posX: number, feetBlockY: number, posZ: number, dirX: number, dirZ: number): boolean {
		const distances = this.stuckTicks > 5 ? [ 0.6, 1.2, 1.8, 2.4 ] : [ 0.8, 1.6 ];

		// Perpendicular unit vector for shoulder offsets
		const perpX = -dirZ;
		const perpZ = dirX;
		const shoulderOffsets = [ 0, 0.3, -0.3 ];

		for (const dist of distances) {
			for (const so of shoulderOffsets) {
				const probeX = posX + dirX * dist + perpX * so;
				const probeZ = posZ + dirZ * dist + perpZ * so;
				const bx = Math.floor(probeX);
				const bz = Math.floor(probeZ);

				const feetBlock = this.bot.blockAt(new Vec3(bx, feetBlockY, bz));
				const headBlock = this.bot.blockAt(new Vec3(bx, feetBlockY + 1, bz));
				if (feetBlock?.boundingBox === "block" && headBlock?.boundingBox === "block") return true;
			}
		}
		return false;
	}

	/** Check if the block at the given position is a hazard (water, bubble column, open trapdoor). */
	private isDangerousBlock(x: number, y: number, z: number): boolean {
		const block = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
		if (!block) return false;
		const name = block.name;
		if (name === "water" || name === "bubble_column") return true;
		if (name.endsWith("_trapdoor")) {
			const open = (block.getProperties() as Record<string, unknown>).open;
			if (open === true || open === "true") return true;
		}
		return false;
	}

}
