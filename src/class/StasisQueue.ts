import { goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { STASIS_TRAPDOOR_RANGE } from "../config";
import { formatPlayer, printObject } from "../utils/format";
import { Bot } from "./Bot";
import { Logger } from "./Logger";
import type { Stasis } from "./Stasis";

export class StasisQueue {

	private static goal: Stasis | null = null;
	private static homePos: null | Vec3 = null;
	private static isAttemptingToClose = false;
	private static queue: Stasis[] = [];
	private static returningHome = false;

	/**
	 * Add a chamber to the pearl queue. 
	 * Will not add if the owner already has a chamber queued or being processed.
	 * @param stasis - The chamber to add to the queue
	 */
	public static add(stasis: Stasis) {
		Logger.log("Queueing stasis:");
		printObject({
			dimension: stasis.dimension,
			owner: formatPlayer(stasis.owner),
			position: stasis.block.position
		});
		this.queue.push(stasis);
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
	 * Get the home position the bot will return to when it has no more chambers to process.
	 * This will be null if the bot is already at home or has never moved from its spawn point.
	 * @returns {Vec3}
	 */
	public static get home(): Vec3 {
		if (this.homePos) return this.homePos;
		return Bot.instance.entity.position.clone().floored();
	}

	/**
	 * Process the pearl queue. Call this every tick.
	 */
	public static async tick() {

		// If we’re currently on a chamber
		if (this.goal) {

			// If the player is no longer online, skip this chamber unqueued
			if (!Bot.instance.players[this.goal.owner.username]) {
				Logger.warn("Skipping stasis for offline player:");
				printObject({ owner: formatPlayer(this.goal.owner) });
				this.goal = null;
				this.isAttemptingToClose = false;
				return;
			}

			// Make sure we arent sneaking
			Bot.instance.setControlState("jump", false);
			Bot.instance.setControlState("sneak", false);

			// Check distance to chamber
			const dist = Bot.instance.entity.position.distanceTo(this.goal.block.position);

			// If were too far, keep walking
			if (dist > STASIS_TRAPDOOR_RANGE) return;

			// Gate to prevent double-activating
			if (this.isAttemptingToClose) return;
			this.isAttemptingToClose = true;
			
			// Activate the chamber
			await this.goal.activate();
			await this.goal.remove();
			this.isAttemptingToClose = false;
			this.goal = null;
			return;
			
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

			// Logger.log(`Processing stasis belonging to ${ chalk.cyan(this.goal.owner.username) } at ${ chalk.yellow(this.goal.block.position) }`);
			Bot.instance.pathfinder.setGoal(new goals.GoalNear(this.goal.block.position.x, this.goal.block.position.y, this.goal.block.position.z, STASIS_TRAPDOOR_RANGE - 1));
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