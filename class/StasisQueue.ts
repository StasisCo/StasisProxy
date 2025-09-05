import chalk from "chalk";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { Bot } from "./Bot";
import { Logger } from "./Logger";
import type { StasisColumn } from "./StasisColumn";

export class StasisQueue {

	private static currentGoal: StasisColumn | null = null;
	private static homePos: null | Vec3 = null;
	private static queue: StasisColumn[] = [];
	private static returningHome = false;
	
	/**
	 * Add a chamber to the pearl queue.
	 * Duplicates are ignored.
	 */
	public static add(chamber: StasisColumn) {
		if (this.queue.includes(chamber)) return;
		this.queue.push(chamber);
	}

	/**
	 * Is the given player already queued for pearl loading?
	 * This includes both queued chambers and the chamber currently being processed.
	 * @param playerUuid - The UUID of the player to check
	 * @returns {boolean} True if the player is queued, false otherwise
	 */
	public static has(playerUuid: string): boolean {
		return this.queue.some(chamber => chamber.owner.uuid === playerUuid) || (this.currentGoal?.owner.uuid === playerUuid);
	}

	/**
	 * Process the pearl queue. Call this every tick.
	 */
	public static async process() {

		// --- If we’re working on a chamber, finish that first ---
		if (this.currentGoal) {
			const interactionBlock = this.currentGoal.block;
			if (!interactionBlock) {
				this.currentGoal = null;
				return;
			}

			const dist = Bot.instance.entity.position.distanceTo(interactionBlock.position);
			if (dist <= 3) {

				// Arrived → interact once, then advance
				this.currentGoal = null;

				Logger.log(`Interacting with chamber at ${ chalk.yellow(interactionBlock.position) }...`);
				await Bot.instance.lookAt(interactionBlock.position, true);
				await Bot.instance.activateBlock(interactionBlock);

				// Next tick will pick up the next chamber or start returning home
			}
			return;
		}

		// --- Not currently on a chamber ---

		// If there’s queued work:
		if (this.queue.length > 0) {

			// Capture home only when a new work session starts (empty -> non-empty)
			if (this.homePos === null) this.homePos = Bot.instance.entity.position.clone().floored();

			// If we were heading home, cancel that and do work (keep original this.homePos)
			this.returningHome = false;

			const chamber = this.queue.shift()!;
			const interactionBlock = chamber.block;
			if (!interactionBlock) return; // skip this one; next tick will try again

			this.currentGoal = chamber;
			Logger.log(`Moving to chamber at ${ chalk.yellow(interactionBlock.position) }...`);
			Bot.instance.pathfinder.setGoal(new goals.GoalNear(interactionBlock.position.x, interactionBlock.position.y, interactionBlock.position.z, 2));
			return;
		}

		// --- Queue is empty ---
		// If we have a saved home and we're not there yet, go home.
		if (this.homePos) {
			const dHome = Bot.instance.entity.position.distanceTo(this.homePos);
			if (dHome > 1) {
				if (!this.returningHome) {
					this.returningHome = true;
					Logger.log(`Returning home to ${ chalk.yellow(this.homePos) }...`);
					Bot.instance.pathfinder.setGoal(new goals.GoalBlock(this.homePos.x, this.homePos.y, this.homePos.z));
				}

				// keep walking; don't clear goal every tick
				return;
			}

			// We arrived home with no new work → end session
			this.returningHome = false;

			// Keep goal as-is (already satisfied) to avoid pathfinder thrash.
			// If you *really* want to clear it once, do it here (but don't call stop()):
			// bot.pathfinder.setGoal(null);
			this.homePos = null; // allow a new home to be captured next time work starts
		}

	}
	
}