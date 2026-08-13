import chalk from "chalk";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { Goal } from "../../../class/Goal";

/** A* search node — block coordinates plus bookkeeping for path reconstruction. */
interface PathNode {
	x: number;
	y: number;
	z: number;
	g: number;
	f: number;
	parent: PathNode | null;
}

export class PathfindingManager {

	private static readonly logger = new Logger(chalk.hex("#38bdf8")("PATH"));

	private queue: Goal[] = [];
	private active: Goal | null = null;
	private home: Vec3Like | null = null;
	private returningHome = false;

	/** True while awaiting async onArrived/onTimeout listeners — blocks premature processNext and returnHome */
	private finishing = false;

	/** Tracks ticks spent without meaningful XZ movement while controls.forward is true */
	private stuckTicks = 0;
	private lastPos = { x: 0, z: 0 };

	/** Watchdog: best (closest) distance to target seen this goal, and ticks since it improved. */
	private bestDistance = Infinity;
	private ticksSinceProgress = 0;

	/** Planned waypoints (block centers) for the active goal, or null when no plan exists yet. */
	private path: Vec3[] | null = null;
	private pathIndex = 0;

	/** Ticks until another A* plan may be computed — prevents replan thrash while wedged. */
	private replanCooldown = 0;

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
			this.home = pos.offset(0.5, 0, 0.5);
		});
	}

	public getHome(): Vec3Like | null {
		return this.home;
	}

	public setHome(position: Vec3Like) {
		this.home = new Vec3(position.x, position.y, position.z);

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
		const pos = new Vec3(this.home.x, this.home.y, this.home.z);

		// Already at home — stay idle instead of creating a new goal that oscillates
		if (this.bot.entity && this.bot.entity.position.distanceTo(pos) <= 0.5) return;

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
		this.path = null;
		this.pathIndex = 0;
		this.replanCooldown = 0;

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
		this.path = null;
		this.pathIndex = 0;

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

		// Refresh solid-entity cells on a 10-tick cadence — shulkers, boats and minecarts
		// barely move within half a second, and rebuilding the set every tick at 1500
		// entities is needless allocation churn on constrained hosts.
		if (this.obstacleRefreshCounter++ % 10 === 0) this.refreshEntityObstacles();

		// Always look straight ahead — prevent pitch getting stuck (e.g. after Stasis.interact() looks at a block below)
		this.bot.entity.pitch = 0;

		// No active goal — check if we've drifted from home and need to return
		if (!this.active) {
			if (!this.finishing && this.home) {
				const home = new Vec3(this.home.x, this.home.y, this.home.z);
				if (this.bot.entity.position.distanceTo(home) > 1.0) {
					this.returnHome();
				}
			}
			return;
		}

		const pos = this.bot.entity.position;
		const targetPos = new Vec3(this.active.position.x, this.active.position.y, this.active.position.z);
		const distance = pos.distanceTo(targetPos);

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
		// isn't changing. The threshold has to account for how fast we could legitimately be
		// moving: using an item cuts movement input to a fifth — about 0.043 blocks per tick —
		// so a bot eating on the move would otherwise register as wedged every tick.
		const moveThreshold = MinecraftClient.physics.isUsingItem ? 0.01 : 0.05;
		const movedDist = Math.abs(pos.x - this.lastPos.x) + Math.abs(pos.z - this.lastPos.z);
		if (movedDist > moveThreshold) {
			this.stuckTicks = 0;
		} else if (MinecraftClient.physics.controls.forward) {
			this.stuckTicks++;
		}
		this.lastPos.x = pos.x;
		this.lastPos.z = pos.z;

		// ─── Plan ────────────────────────────────────────────────

		if (this.replanCooldown > 0) this.replanCooldown--;

		// Replan when: no plan exists, the plan ran out without arriving, we've been wedged
		// long enough that the plan clearly doesn't match reality (a block changed, we got
		// knocked back), or we've drifted well off the current waypoint.
		const currentWp = this.path?.[this.pathIndex] ?? null;
		const driftedOffPath = currentWp !== null &&
			Math.hypot(pos.x - currentWp.x, pos.z - currentWp.z) > 4.0;

		if (this.replanCooldown === 0 && (this.path === null || currentWp === null || this.stuckTicks > 12 || driftedOffPath)) {

			// A wedge the world model can't explain (nothing solid ahead, yet no movement) is
			// an invisible-to-us obstruction — learn it before planning so the new route
			// actually avoids it instead of recomputing the same straight line.
			if (this.stuckTicks > 12) this.markStallObstacles();

			this.path = this.planPath(targetPos, this.active.range);
			this.pathIndex = 0;
			this.stuckTicks = 0;

			// A failed plan retries on a slower cadence than a successful one refreshes —
			// hammering A* every tick against an unloaded or walled-off target just burns CPU
			// until the no-progress watchdog fires.
			this.replanCooldown = this.path === null ? 40 : 20;
		}

		// ─── Follow ──────────────────────────────────────────────

		let aim: Vec3 | null = null;

		if (this.path !== null) {

			// Advance past every waypoint we've reached. The Y window is generous downward
			// (mid-fall the waypoint is below us) but tight upward so a waypoint on a ledge
			// above isn't "reached" by standing underneath it.
			for (;;) {
				const wp = this.path[this.pathIndex];
				if (wp === undefined) break;
				const dxz = Math.hypot(pos.x - wp.x, pos.z - wp.z);
				const dy = pos.y - wp.y;
				if (dxz < 0.45 && dy > -0.75 && dy < 1.6) this.pathIndex++;
				else break;
			}

			const wp = this.path[this.pathIndex];
			if (wp !== undefined) {
				aim = wp;
			} else {

				// Plan exhausted without arriving (best-effort path to an unreachable target,
				// or the goal range check simply hasn't passed yet) — head straight at the
				// target and let the next replan or the watchdog sort it out.
				this.path = null;
			}
		}

		// Fallback: no plan — steer directly at the target, but never walk into a hazard.
		if (aim === null) {
			const dx = targetPos.x - pos.x;
			const dz = targetPos.z - pos.z;
			const len = Math.hypot(dx, dz);
			if (len > 0.01) {
				const ax = pos.x + dx / len;
				const az = pos.z + dz / len;
				if (this.isDangerousBlock(ax, pos.y, az) || this.isDangerousBlock(ax, pos.y - 1, az)) {
					MinecraftClient.physics.controls.forward = false;
				} else {
					aim = targetPos;
				}
			}
		}

		if (aim !== null) {
			const dx = aim.x - pos.x;
			const dz = aim.z - pos.z;
			if (Math.hypot(dx, dz) > 0.01) {
				this.bot.entity.yaw = Math.atan2(-dx, -dz);
				MinecraftClient.physics.controls.forward = true;
			}
		}

		// ─── Jumping ─────────────────────────────────────────────

		const entity = this.bot.entity as typeof this.bot.entity & { isCollidedHorizontally?: boolean };
		const feetBy = Math.floor(pos.y);

		// Planned step-up: the current waypoint is a block above us and close — jump for it.
		const wpAbove = aim !== null && aim !== targetPos &&
			aim.y > pos.y + 0.5 && Math.hypot(pos.x - aim.x, pos.z - aim.z) < 1.4;

		// Preemptive jump — if there's a 1-high obstacle (solid foot, air head) directly ahead in the
		// current heading, jump now rather than waiting until we're wedged into it.
		const headingX = -Math.sin(this.bot.entity.yaw);
		const headingZ = -Math.cos(this.bot.entity.yaw);
		const aheadX = pos.x + headingX * 0.6;
		const aheadZ = pos.z + headingZ * 0.6;
		const aheadBx = Math.floor(aheadX);
		const aheadBz = Math.floor(aheadZ);
		const footAhead = this.bot.blockAt(new Vec3(aheadBx, feetBy, aheadBz));
		const headAhead = this.bot.blockAt(new Vec3(aheadBx, feetBy + 1, aheadBz));

		// Only jump the step when it's actually clearable: our own column needs rising room
		// above the head, and the landing spot needs the same 3-high clearance the planner
		// demands — jumping into a 2-high pocket just bonks the ceiling and wedges us.
		const oneHighObstacle = footAhead?.boundingBox === "block" &&
			headAhead?.boundingBox !== "block" &&
			!this.isSolidCell(Math.floor(pos.x), feetBy + 2, Math.floor(pos.z)) &&
			!this.isSolidCell(aheadBx, feetBy + 2, aheadBz) &&
			!this.isSolidCell(aheadBx, feetBy + 3, aheadBz);

		// 2-tall tunnel detection: the lowest collision surface above the bot's
		// feet must be exactly 2.0 blocks up (within float epsilon). Using
		// real collision shapes — not just the coarse `boundingBox === "block"`
		// flag — means a closed trapdoor or top-slab above the head gives
		// >2 blocks of headroom and we won't repeatedly jump into it.
		const ceilingY = this.getCeilingY(pos.x, pos.y, pos.z);
		const inTwoTallTunnel = ceilingY !== null && Math.abs(ceilingY - (feetBy + 2)) < 0.01;

		// Suppress the speed-jump when we're about to need precision: within
		// 2 blocks of the target, or within 2 blocks of a solid block ahead.
		// Jumping in those cases causes us to sail past the spot and have to
		// double back.
		const needsPrecision = distance <= 2.0 || this.isSolidWithin(pos, headingX, headingZ, 2.0);
		const tunnelSpeedJump = inTwoTallTunnel && !needsPrecision;

		if (tunnelSpeedJump && MinecraftClient.physics.controls.forward) {
			MinecraftClient.physics.controls.sprint = true;
		}

		// A horizontal collision normally means "hop the lip we're pressed against", but when the
		// thing ahead is a full 2-high wall no jump clears it — bunny-hopping against it just
		// burns hunger and fights the path that's trying to route around.
		const twoHighAhead = this.isWallAhead(pos.x, feetBy, pos.z, headingX, headingZ);

		MinecraftClient.physics.controls.jump = entity.onGround &&
			(wpAbove || oneHighObstacle || (!!entity.isCollidedHorizontally && !twoHighAhead) || tunnelSpeedJump);
	}

	// ─── A* planning ─────────────────────────────────────────────

	/**
	 * A* over the block grid from the bot's position toward `target`, succeeding on any
	 * node whose center is within `range` of the target. Returns waypoints as block
	 * centers, or a best-effort path toward the closest reachable point when the target
	 * is walled off, or null when even that gains nothing.
	 *
	 * Moves: 4 cardinals (flat, 1-up jump, up-to-3 drop) and 4 flat diagonals (both
	 * adjacent cardinal columns must be clear — no corner clipping). Unloaded chunks
	 * read as solid so the search never plans through unknown terrain.
	 */
	private planPath(target: Vec3, range: number): Vec3[] | null {
		const start = this.bot.entity.position.floored();
		const startKey = `${ start.x },${ start.y },${ start.z }`;

		// Range 0 goals still need a node to terminate on — accept anything whose center
		// is within ~a block of the target so sub-block target positions resolve.
		const acceptDistSq = Math.max(range, 0.9) ** 2;
		const MAX_EXPANSIONS = 6000;

		const open: PathNode[] = [];
		const gScore = new Map<string, number>();
		const heuristic = (x: number, y: number, z: number) =>
			Math.sqrt((x + 0.5 - target.x) ** 2 + (y - target.y) ** 2 + (z + 0.5 - target.z) ** 2);

		const push = (node: PathNode) => {
			open.push(node);
			let i = open.length - 1;
			while (i > 0) {
				const p = (i - 1) >> 1;
				if (open[p]!.f <= open[i]!.f) break;
				[ open[p], open[i] ] = [ open[i]!, open[p]! ];
				i = p;
			}
		};

		const pop = (): PathNode => {
			const top = open[0]!;
			const last = open.pop()!;
			if (open.length > 0) {
				open[0] = last;
				let i = 0;
				for (;;) {
					const l = i * 2 + 1;
					const r = l + 1;
					let m = i;
					if (l < open.length && open[l]!.f < open[m]!.f) m = l;
					if (r < open.length && open[r]!.f < open[m]!.f) m = r;
					if (m === i) break;
					[ open[m], open[i] ] = [ open[i]!, open[m]! ];
					i = m;
				}
			}
			return top;
		};

		const startNode: PathNode = { x: start.x, y: start.y, z: start.z, g: 0, f: heuristic(start.x, start.y, start.z), parent: null };
		gScore.set(startKey, 0);
		push(startNode);

		// Track the node that got closest to the target, for best-effort paths when the
		// search exhausts without reaching it.
		let bestNode = startNode;
		let bestH = startNode.f;

		const CARDINALS: ReadonlyArray<readonly [number, number]> = [ [ 1, 0 ], [ -1, 0 ], [ 0, 1 ], [ 0, -1 ] ];
		const DIAGONALS: ReadonlyArray<readonly [number, number]> = [ [ 1, 1 ], [ 1, -1 ], [ -1, 1 ], [ -1, -1 ] ];

		let expansions = 0;
		while (open.length > 0 && expansions < MAX_EXPANSIONS) {
			const node = pop();
			expansions++;

			// Terminate only on a spot the bot can actually stand in — 2 blocks of clearance.
			// Every expanded node already passed that check on the way in, but the start node
			// never did, and the goal spot deserves the explicit guarantee.
			const distSq = (node.x + 0.5 - target.x) ** 2 + (node.y - target.y) ** 2 + (node.z + 0.5 - target.z) ** 2;
			if (distSq <= acceptDistSq && this.isColumnClear(node.x, node.y, node.z)) return this.reconstruct(node);

			const h = heuristic(node.x, node.y, node.z);
			if (h < bestH) {
				bestH = h;
				bestNode = node;
			}

			const consider = (nx: number, ny: number, nz: number, cost: number) => {
				const key = `${ nx },${ ny },${ nz }`;
				const g = node.g + cost;
				const known = gScore.get(key);
				if (known !== undefined && known <= g) return;
				gScore.set(key, g);
				push({ x: nx, y: ny, z: nz, g, f: g + heuristic(nx, ny, nz), parent: node });
			};

			for (const [ dx, dz ] of CARDINALS) {
				const nx = node.x + dx;
				const nz = node.z + dz;

				if (this.isColumnClear(nx, node.y, nz)) {

					// Flat move, or drop up to 3 blocks to the first solid floor
					if (this.isStandableFloor(nx, node.y, nz)) {
						consider(nx, node.y, nz, 1);
					} else {
						for (let drop = 1; drop <= 3; drop++) {
							const ny = node.y - drop;
							if (!this.isColumnClear(nx, ny, nz)) break;
							if (this.isStandableFloor(nx, ny, nz)) {
								consider(nx, ny, nz, 1 + drop * 0.5);
								break;
							}
						}
					}
				} else if (

					// Jump up one: headroom above our own head at takeoff, and a standable
					// landing column that is 3 blocks clear (feet, head, plus the cell the
					// head sweeps through mid-arc) so the jump doesn't bonk a ceiling.
					!this.isSolidCell(node.x, node.y + 2, node.z) &&
					this.isColumnClear(nx, node.y + 1, nz) &&
					!this.isSolidCell(nx, node.y + 3, nz) &&
					this.isStandableFloor(nx, node.y + 1, nz)
				) {
					consider(nx, node.y + 1, nz, 2);
				}
			}

			for (const [ dx, dz ] of DIAGONALS) {
				const nx = node.x + dx;
				const nz = node.z + dz;

				// Both orthogonal columns must be clear — the 0.6-wide hitbox clips the
				// corner block otherwise and the bot wedges on geometry A* said was fine.
				if (!this.isColumnClear(node.x + dx, node.y, node.z)) continue;
				if (!this.isColumnClear(node.x, node.y, node.z + dz)) continue;
				if (!this.isColumnClear(nx, node.y, nz)) continue;
				if (!this.isStandableFloor(nx, node.y, nz)) continue;
				consider(nx, node.y, nz, Math.SQRT2);
			}
		}

		// Search exhausted. If some node got meaningfully closer than where we stand,
		// walk there — inching toward a walled-off target beats standing still, and the
		// no-progress watchdog still bounds the whole attempt.
		if (bestNode !== startNode && bestH < heuristic(start.x, start.y, start.z) - 1.5) {
			return this.reconstruct(bestNode);
		}
		return null;
	}

	/** Rebuild the waypoint list (block centers) by walking parents back to the start. */
	private reconstruct(node: PathNode): Vec3[] {
		const out: Vec3[] = [];
		let cur: PathNode | null = node;
		while (cur !== null) {
			out.push(new Vec3(cur.x + 0.5, cur.y, cur.z + 0.5));
			cur = cur.parent;
		}
		out.reverse();

		// Drop the start node — we're standing on it.
		if (out.length > 1) out.shift();
		return out;
	}

	/**
	 * Cells that read as clear in our world copy but that movement provably cannot pass —
	 * learned from walk stalls, expiring after a while. The server is 1.21.x behind
	 * ViaVersion and we parse the downgraded 1.20.1 chunks, so a 1.21-only block whose
	 * substitute has different collision is an invisible wall to us: the world says air,
	 * the server says solid, and every sim step into it gets rolled back. Marking the
	 * stall cells solid lets the planner route around what it cannot see.
	 */
	private readonly stallObstacles = new Map<string, number>();

	/** Mark the cells ahead of a stalled walk as temporarily solid, so replans avoid them. */
	private markStallObstacles() {
		const entity = this.bot.entity;
		if (!entity) return;
		const pos = entity.position;
		const feetY = Math.floor(pos.y);
		const headingX = -Math.sin(entity.yaw);
		const headingZ = -Math.cos(entity.yaw);
		const perpX = -headingZ;
		const perpZ = headingX;

		const now = Date.now();
		for (const [ key, expiry ] of this.stallObstacles) {
			if (expiry <= now) this.stallObstacles.delete(key);
		}

		const marked: string[] = [];
		for (const dist of [ 0.6, 1.1 ]) {
			for (const shoulder of [ 0, 0.3, -0.3 ]) {
				const bx = Math.floor(pos.x + headingX * dist + perpX * shoulder);
				const bz = Math.floor(pos.z + headingZ * dist + perpZ * shoulder);
				if (bx === Math.floor(pos.x) && bz === Math.floor(pos.z)) continue;
				for (const dy of [ 0, 1 ]) {
					const key = `${ bx },${ feetY + dy },${ bz }`;
					if (!this.stallObstacles.has(key)) {
						marked.push(`${ key }(${ this.bot.blockAt(new Vec3(bx, feetY + dy, bz))?.name ?? "?" })`);
					}
					this.stallObstacles.set(key, now + 30_000);
				}
			}
		}
		if (marked.length > 0) {
			PathfindingManager.logger.warn(`Walk stalled — marking unpassable cells for 30s: ${ marked.join(" ") }`);
		}
	}

	/**
	 * Cells occupied by entities the server collides players against like blocks — shulkers,
	 * boats and minecarts (vanilla `canBeCollidedWith`). The anticheat includes their hitboxes
	 * in its movement simulation but prismarine-physics has no entity collision at all, so a
	 * step planned through one is a guaranteed rollback. At entity-dense farms (hundreds of
	 * shulkers) that turned every walk into a one-step-per-seconds stutter. Rebuilt each tick.
	 */
	private readonly entityObstacles = new Set<string>();

	private obstacleRefreshCounter = 0;

	private refreshEntityObstacles() {
		this.entityObstacles.clear();
		for (const id in this.bot.entities) {
			const entity = this.bot.entities[id];
			if (entity === undefined || entity.isValid === false) continue;
			const name = entity.name ?? "";
			if (name !== "shulker" && !name.endsWith("boat") && !name.includes("minecart")) continue;

			const half = (entity.width ?? 1) / 2;
			const y = Math.floor(entity.position.y);
			const minX = Math.floor(entity.position.x - half);
			const maxX = Math.floor(entity.position.x + half);
			const minZ = Math.floor(entity.position.z - half);
			const maxZ = Math.floor(entity.position.z + half);
			for (let x = minX; x <= maxX; x++) {
				for (let z = minZ; z <= maxZ; z++) {
					this.entityObstacles.add(`${ x },${ y },${ z }`);
				}
			}
		}
	}

	/** Solid for pathing purposes. Unloaded blocks count as solid — never plan through the unknown. */
	private isSolidCell(x: number, y: number, z: number): boolean {
		const key = `${ x },${ y },${ z }`;
		if (this.entityObstacles.has(key)) return true;

		const expiry = this.stallObstacles.get(key);
		if (expiry !== undefined && expiry > Date.now()) return true;

		const block = this.bot.blockAt(new Vec3(x, y, z));
		if (!block) return true;
		return block.boundingBox === "block";
	}

	/** Feet and head cells passable and hazard-free at the given feet position. */
	private isColumnClear(x: number, y: number, z: number): boolean {
		if (this.isSolidCell(x, y, z) || this.isSolidCell(x, y + 1, z)) return false;
		if (this.isDangerousBlock(x, y, z)) return false;
		return true;
	}

	/** A floor we can stand on: solid below, and not itself a hazard (open trapdoor, water). */
	private isStandableFloor(x: number, y: number, z: number): boolean {
		if (!this.isSolidCell(x, y - 1, z)) return false;
		if (this.isDangerousBlock(x, y - 1, z)) return false;
		return true;
	}

	// ─── Probes shared with jump control ─────────────────────────

	/**
	 * Check if there is a 2-high solid wall in the given direction.
	 * Probes multiple distances ahead and offsets perpendicular to the heading
	 * to account for the player's ~0.6-wide hitbox. Only flags as blocked when
	 * both feet- and head-level cells are solid at any probed point (1-high
	 * obstacles can be jumped).
	 */
	private isWallAhead(posX: number, feetBlockY: number, posZ: number, dirX: number, dirZ: number): boolean {
		const distances = [ 0.8, 1.6 ];

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

	/**
	 * Probe along the current heading for a solid block at feet- or head-level
	 * within `maxDist` blocks. Used to suppress proactive speed-jumping when
	 * close to walls/obstacles, where momentum from a jump would overshoot.
	 */
	private isSolidWithin(pos: { x: number; y: number; z: number }, headingX: number, headingZ: number, maxDist: number): boolean {
		const by = Math.floor(pos.y);
		for (let d = 0.5; d <= maxDist + 1e-6; d += 0.5) {
			const probeX = pos.x + headingX * d;
			const probeZ = pos.z + headingZ * d;
			const bx = Math.floor(probeX);
			const bz = Math.floor(probeZ);
			const feetBlock = this.bot.blockAt(new Vec3(bx, by, bz));
			const headBlock = this.bot.blockAt(new Vec3(bx, by + 1, bz));
			if (feetBlock?.boundingBox === "block" || headBlock?.boundingBox === "block") return true;
		}
		return false;
	}

	/**
	 * Find the world-Y of the lowest collision surface directly above the
	 * given XZ point starting from `feetY`. Walks the column upward one block
	 * at a time and inspects each block's actual `shapes` (per-block AABBs)
	 * rather than the coarse `boundingBox` flag, so partial blocks such as
	 * trapdoors, top slabs and stairs report their true collision face.
	 * Returns null if nothing solid is found within 4 blocks above.
	 */
	private getCeilingY(x: number, feetY: number, z: number): number | null {
		const bx = Math.floor(x);
		const bz = Math.floor(z);
		const startBy = Math.floor(feetY);
		let lowest = Infinity;

		for (let dy = 1; dy <= 4; dy++) {
			const by = startBy + dy;
			const block = this.bot.blockAt(new Vec3(bx, by, bz));
			if (!block?.shapes?.length) continue;
			for (const shape of block.shapes) {

				// shape = [xmin, ymin, zmin, xmax, ymax, zmax] in local block coords
				const worldMinY = by + shape[1];
				if (worldMinY > feetY + 0.01 && worldMinY < lowest) lowest = worldMinY;
			}
			if (lowest !== Infinity) break;
		}

		return lowest === Infinity ? null : lowest;
	}

	/** Check if the block at the given position is a hazard (water, bubble column, lava, open trapdoor). */
	private isDangerousBlock(x: number, y: number, z: number): boolean {
		const block = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
		if (!block) return false;
		const name = block.name;
		if (name === "water" || name === "bubble_column" || name === "lava" || name === "fire") return true;
		if (name.endsWith("_trapdoor")) {
			const open = (block.getProperties() as Record<string, unknown>).open;
			if (open === true || open === "true") return true;
		}
		return false;
	}

}
