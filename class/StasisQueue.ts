import chalk from "chalk";
import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { Bot } from "./Bot";
import { Logger } from "./Logger";
import type { StasisColumn } from "./StasisColumn";

export class StasisQueue {

	private static goal: StasisColumn | null = null;
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
		return this.queue.some(chamber => chamber.owner.uuid === playerUuid) || (this.goal?.owner.uuid === playerUuid);
	}

	/**
	 * Process the pearl queue. Call this every tick.
	 */
	public static async tick() {

		// If we’re currently on a chamber
		if (this.goal) {

			// Check distance to chamber
			const dist = Bot.instance.entity.position.distanceTo(this.goal.block.position);

			// If were too far, keep walking
			if (dist > 3) return;

			// If theres pearls in the chamber, pull them
			if (this.goal.entities.length > 0) {
				await Bot.instance.lookAt(this.goal.block.position, true);
				await Bot.instance.activateBlock(this.goal.block);
				return;
			}
			
			Logger.log(`Loaded stasis belonging to ${ chalk.cyan(this.goal.owner.username) } at ${ chalk.yellow(this.goal.block.position) }`);

			await this.goal.remove();
			return this.goal = null;
			
		}

		// If theres a chamber queued
		if (this.queue.length > 0) {

			// Save our return position if we dont have one already
			if (this.homePos === null) this.homePos = Bot.instance.entity.position.clone().floored();
			
			// Stop going home if we were
			this.returningHome = false;

			// Get the next chamber in the queue
			this.goal = this.queue.shift() || null;
			if (!this.goal) return;

			Logger.log(`Processing stasis belonging to ${ chalk.cyan(this.goal.owner.username) } at ${ chalk.yellow(this.goal.block.position) }`);
			Bot.instance.pathfinder.setGoal(new goals.GoalNear(this.goal.block.position.x, this.goal.block.position.y, this.goal.block.position.z, 2));
			return;

		}

		// Return home if we dont have any work to do
		if (this.homePos) {

			// See how far we are from home
			const dist = Bot.instance.entity.position.distanceTo(this.homePos);

			// If we have arrived
			if (dist < 1) {
				this.returningHome = false;
				this.homePos = null;
				return;
			}

			// Return home if were not already
			if (!this.returningHome) {
				this.returningHome = true;
				Bot.instance.pathfinder.setGoal(new goals.GoalBlock(this.homePos.x, this.homePos.y, this.homePos.z));
			}

		}

	}
	
}