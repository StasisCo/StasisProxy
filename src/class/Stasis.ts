import { type Stasis as StasisRecord } from "@prisma/client";
import chalk from "chalk";
import type { Dimension, Player } from "mineflayer";
import type { Block } from "prismarine-block";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { prisma } from "..";
import { Bot } from "./Bot";
import { Logger } from "./Logger";

export class Stasis {

	/**
	 * The date this stasis was created, if it has been saved
	 */
	public readonly createdAt?: Date;

	/**
	 * The dimension this stasis is in
	 */
	public readonly dimension: Dimension;

	/**
	 * The database ID of this stasis, if it has been saved
	 */
	public readonly id?: string;

	/**
	 * The player who owns the pearl in this stasis
	 */
	public readonly owner: Player;

	/**
	 * The first corner of the stasis (the top trapdoor block)
	 */
	private readonly pos1: Vec3;

	/**
	 * The second corner of the stasis (the soul sand block)
	 */
	private readonly pos2: Vec3;

	/**
	 * Fetches all stasis from the database for the given player
	 * @param player - The player whose stasis to fetch
	 * @returns {Stasis[]} An array of stasis instances
	 */
	public static async fetch(player: Player): Promise<Stasis[]> {

		// Get all the active stasis in the database for this player
		const stasis = await prisma.stasis.findMany({
			where: {
				dimension: Bot.instance.game.dimension,
				owner: player.uuid,
				observer: Bot.instance.player.uuid,
				server: Bot.server
			}
		})
		
			// .map them to Stasis instances, filtering out any that fail
			.then(stasis => stasis.map(Stasis.from).filter(stasis => stasis !== null));
			
		// Cleanup any orphaned pearls
		const orphaned = stasis.filter(stasis => stasis.entities.length === 0);
		if (orphaned.length > 0) {
			Logger.warn(`Removing ${ chalk.yellow(orphaned.length) } orphaned stasis...`);
			for (const orphan of orphaned) await orphan.remove();
		}

		return stasis.filter(stasis => stasis.entities.length > 0);

	}

	/**
	 * Gets the stasis from a database record
	 * @param record - A stasis record from the database
	 * @returns {Stasis} The stasis instance
	 */
	public static from(record: StasisRecord): Stasis;

	/**
	 * Gets the stasis from a block position that is part of the stasis
	 * @param position - A block position that is part of the stasis
	 * @param owner - The UUID of the player who owns the stasis
	 * @returns {Stasis | null} The stasis instance, or null if not found
	 */
	public static from(position: Vec3, owner: string): Stasis | null;

	/**
	 * Factory method overload
	 * @param arg1
	 * @param arg2 
	 * @returns {Stasis | null}
	 */
	static from(arg1: StasisRecord | Vec3, arg2?: string): Stasis | null {

		// record overload
		if (typeof arg2 !== "string") {
			const rec = arg1 as StasisRecord;
			return new Stasis(new Vec3(rec.x, rec.y, rec.z), rec.owner, rec.id);
		}

		// (position, owner) overload
		try {
			return new Stasis(arg1 as Vec3, arg2);
		} catch {
			return null;
		}
	}

	/**
	 * Private constructor, use Stasis.from() instead
	 * @param position - A block position that is part of the stasis
	 * @param owner - The UUID of the player who owns the stasis
	 * @param id - The database ID of the stasis, if it has been saved
	 */
	private constructor(position: Vec3, owner: string, id?: string) {

		// Get the owner player
		const ownerEntity = Object.values(Bot.instance.players).find(e => e.uuid === owner || e.username === owner);
		if (!ownerEntity) throw new Error("Failed to find owner entity for stasis");

		// Walk down from the starting position until we find the soul sand at the bottom
		let soulSandY = position.y;
		while (soulSandY >= -64) {
			const block = Bot.instance.blockAt(new Vec3(position.x, soulSandY, position.z));
			if (!block) throw new Error("Failed to find stasis blocks");
			if (block.name === "soul_sand") break;
			soulSandY--;
		}

		// Walk up from the soul sand until we find the top bubble column block
		let trapdoorY = soulSandY;
		while (trapdoorY <= 320) {
			const block = Bot.instance.blockAt(new Vec3(position.x, trapdoorY, position.z));
			if (!block) throw new Error("Failed to find stasis blocks");
			if (block.name.includes("trapdoor") && block.name !== "iron_trapdoor") break;
			trapdoorY++;
		}

		this.pos1 = new Vec3(position.x, trapdoorY, position.z);
		this.pos2 = new Vec3(position.x, soulSandY, position.z);
		this.dimension = Bot.instance.game.dimension;
		this.owner = ownerEntity;
		this.id = id;

	}

	/**
	 * Get the block to interact with to activate the stasis
	 * @returns {Block} The trapdoor block
	 */
	public get block(): Block {
		const block = Bot.instance.blockAt(this.pos1);
		if (!block) throw new Error("Failed to get trapdoor block for stasis");
		if (!block.name.includes("trapdoor") || block.name === "iron_trapdoor") throw new Error("No valid trapdoor found above the stasis");
		return block;
	}

	/**
	 * Get all ender pearls currently in the bounding box of the stasis
	 * @returns {Entity[]} An array of ender pearl entities
	 */
	public get entities(): Entity[] {
		return Object.values(Bot.instance.entities)
			.filter(e => e.type === "projectile" && e.name === "ender_pearl")
			.filter(e => Bot.instance.blockAt(e.position)?.position.x === this.pos1.x)
			.filter(e => Bot.instance.blockAt(e.position)?.position.z === this.pos1.z)
			.filter(e => Bot.instance.blockAt(e.position)?.position.y || 0 <= Math.min(this.pos1.y, this.pos2.y))
			.filter(e => Bot.instance.blockAt(e.position)?.position.y || 0 >= Math.max(this.pos1.y, this.pos2.y));
	}

	/**
	 * Get the state of the stasis
	 */
	public get state() {
		const state = this.block.getProperties();
		const open = Boolean("open" in state && state.open);
		const occupied = this.entities.length > 0;
		const pearl = this.entities.find(e => e.position.distanceTo(this.block.position) <= Math.SQRT2);
		const distance = pearl ? pearl.position.distanceTo(this.block.position) : Infinity;
		const ready = pearl && distance <= Math.SQRT2 && pearl.velocity.abs().x <= 0.1 && pearl.velocity.abs().y <= 0.1 && pearl.velocity.abs().z <= 0.1 || false;
		return { occupied, open, ready };
	}

	/**
	 * Remove this stasis from the database
	 * @returns {Promise<boolean>} whether the removal was successful
	 */
	public async remove(): Promise<boolean> {
		return await prisma.stasis.deleteMany({ where: this.toJSON() })
			.then(() => true)
			.catch(() => false);
	}

	/**
	 * Resolve when the stasis is ready, throws if it times out or fails
	 * @param timeout - The maximum time to wait in milliseconds (default: 10000)
	 */
	public async onReady(timeout = 10_000): Promise<void> {
		return await new Promise<void>((resolve, reject) => {
			const start = Date.now();
			function loop(this: Stasis): void {
				if (this.state.ready) return resolve();
				if (Date.now() - start >= timeout) return reject();
				Bot.instance.waitForTicks(1).then(() => loop.call(this));
			}
			loop.call(this);
		});
	}

	/**
	 * Activate the stasis by opening the trapdoor
	 * (assuming its within reach)
	 * @returns {Promise<void>}
	 */
	public async activate(): Promise<void> {
		while (this.state.open) {
			await Bot.instance.lookAt(this.block.position, true);
			await Bot.instance.activateBlock(this.block);
			await Bot.instance.waitForTicks(2);
		}

		// Wait for there to be no pearls left
		while (this.entities.length > 0) await Bot.instance.waitForTicks(2);
	}

	/**
	 * Serialize the stasis to JSON
	 * @returns The stasis as a JSON object
	 */
	public toJSON() {
		if (!this.owner.uuid) throw new Error("Failed to determine owner UUID for stasis");
		return {
			id: this.id,
			createdAt: this.createdAt,
			dimension: Bot.instance.game.dimension,
			observer: Bot.instance.player.uuid,
			owner: this.owner.uuid,
			server: Bot.server,
			x: this.block.position.x,
			y: this.block.position.y,
			z: this.block.position.z
		};
	}
	
}