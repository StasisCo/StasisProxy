import type { Bot as Mineflayer } from "mineflayer";
import { Vec3 } from "vec3";
import { Client } from "~/app/Client";
import { Goal } from "../class/Goal";

export class PathfindingManager {

	private queue: Goal[] = [];
	private active: Goal | null = null;
	private home: Vec3 | null = null;
	private returningHome = false;

	constructor(private readonly bot: Mineflayer) {
		const init = () => {
			Client.physics.onPreTick.push(() => this.update());
		};

		const afterQueue = () => {
			if (Client.queue?.queued) {
				Client.queue.once("leave-queue", () => bot.once("spawn", init));
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
		} else if (!this.active) {
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
		Client.physics.controls.forward = true;
		Client.physics.controls.sprint = !this.returningHome;

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

		// Await all listeners so async handlers (interact, remove, etc.) complete
		// before the next goal is started.
		const listeners = goal.listeners(reason);
		await Promise.allSettled(listeners.map(fn => fn()));
	}

	private stopMovement() {
		Client.physics.controls.forward = false;
		Client.physics.controls.sprint = false;
		Client.physics.controls.jump = false;
	}

	private async update() {
		if (!this.bot.entity) return;

		// Always look straight ahead — prevent pitch getting stuck (e.g. after Stasis.interact() looks at a block below)
		this.bot.entity.pitch = 0;

		// No active goal — check if we've drifted from home and need to return
		if (!this.active) {
			if (this.home && this.bot.entity.position.distanceTo(this.home) > 1.0) {
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

		// Steer toward target, avoiding hazards
		const dx = target.x - pos.x;
		const dz = target.z - pos.z;
		const len = Math.sqrt(dx * dx + dz * dz);

		if (len > 0.01) {
			const yaw = this.findSafeYaw(pos, dx / len, dz / len);
			if (yaw !== null) {
				this.bot.entity.yaw = yaw;
				Client.physics.controls.forward = true;
			} else {

				// All checked directions blocked by hazards — stop
				Client.physics.controls.forward = false;
			}
		}

		const entity = this.bot.entity as typeof this.bot.entity & { isCollidedHorizontally?: boolean };
		Client.physics.controls.jump = !!entity.isCollidedHorizontally && entity.onGround;
	}

	/**
	 * Find a yaw that steers toward the target while avoiding dangerous blocks.
	 * Tries the direct path first, then offsets up to ±90°.
	 */
	private findSafeYaw(pos: { x: number; y: number; z: number }, nx: number, nz: number): number | null {
		const offsets = [ 0, 25, -25, 50, -50, 75, -75, 90, -90 ];
		const feetY = pos.y;

		for (const deg of offsets) {
			const rad = deg * Math.PI / 180;
			const c = Math.cos(rad);
			const s = Math.sin(rad);
			const dirX = nx * c - nz * s;
			const dirZ = nx * s + nz * c;

			const ax = pos.x + dirX;
			const az = pos.z + dirZ;

			if (!this.isDangerousBlock(ax, feetY, az) &&
				!this.isDangerousBlock(ax, feetY - 1, az)) {
				return Math.atan2(-dirX, -dirZ);
			}
		}

		return null;
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
