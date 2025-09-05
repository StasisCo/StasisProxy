import { type Stasis as StasisRecord } from "@prisma/client";
import type { Player } from "mineflayer";
import type { Block } from "prismarine-block";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { prisma } from "..";
import { Bot } from "./Bot";

export class StasisColumn {

	/**
	 * The date this chamber was created, if it has been saved
	 */
	public readonly createdAt?: Date;

	/**
	 * The database ID of this chamber, if it has been saved
	 */
	public readonly id?: string;

	/**
	 * The player who owns the pearl in this chamber
	 */
	public readonly owner: Player;

	/**
	 * The bounding box of the chamber
	 */
	public readonly pos1: Vec3;
	public readonly pos2: Vec3;

	/**
	 * Gets the chamber from a database record
	 * @param record - A chamber record from the database
	 * @returns {StasisColumn} The chamber instance
	 */
	public static from(record: StasisRecord): StasisColumn;

	/**
	 * Gets the chamber from a block position that is part of the chamber
	 * @param position - A block position that is part of the chamber
	 * @param owner - The UUID of the player who owns the chamber
	 * @returns {StasisColumn | null} The chamber instance, or null if not found
	 */
	public static from(position: Vec3, owner: string): StasisColumn | null;

	/**
	 * Factory method overload
	 * @param arg1
	 * @param arg2 
	 * @returns {StasisColumn | null}
	 */
	static from(arg1: StasisRecord | Vec3, arg2?: string): StasisColumn | null {

		// record overload
		if (typeof arg2 !== "string") {
			const rec = arg1 as StasisRecord;
			return new StasisColumn(new Vec3(rec.x, rec.y, rec.z), rec.owner, rec.id);
		}

		// (position, owner) overload
		try {
			return new StasisColumn(arg1 as Vec3, arg2);
		} catch {
			return null;
		}
	}

	private constructor(position: Vec3, owner: string, id?: string) {

		// Walk up to find the top of the bubble column
		let startPos = position.y;
		while (true) {
			const block = Bot.instance.blockAt(new Vec3(position.x, startPos, position.z));
			if (!block) break;
			if (block.name === "bubble_column") startPos++;
			else break;
		}

		// Detect the bubble column
		let columnTop;
		let columnBottom;
		for (let y = startPos; y >= -64; y--) {
			const block = Bot.instance.blockAt(new Vec3(position.x, y, position.z));
			if (!block) continue;
			if (block.name === "bubble_column" && !columnTop) columnTop = block;
			if (block.name === "soul_sand") {
				columnBottom = block;
				break;
			}
		}

		if (!columnTop || !columnBottom) throw new Error("No stasis chamber found at the given position");

		// Make sure theres a trapdoor above the top
		const block = Bot.instance.blockAt(new Vec3(columnTop.position.x, columnTop.position.y + 1, columnTop.position.z));
		if (!block || !block.name.includes("trapdoor") || block.name === "iron_trapdoor") throw new Error("No valid trapdoor found above the stasis chamber");

		const ownerEntity = Object.values(Bot.instance.players).find(e => e.uuid === owner);
		if (!ownerEntity) throw new Error("Failed to find owner entity for stasis chamber");

		this.pos1 = columnTop.position;
		this.pos2 = columnBottom.position;
		this.owner = ownerEntity;
		this.id = id;

	}

	/**
	 * Remove this chamber from the database
	 */
	public async remove() {
		return await prisma.stasis.deleteMany({ where: this.toJSON() })
			.then(() => true)
			.catch(() => false);
	}

	/**
	 * Get the block to interact with to activate the chamber
	 * @returns {Block} The trapdoor block
	 */
	public get block(): Block {
		const block = Bot.instance.blockAt(new Vec3(this.pos1.x, this.pos1.y + 1, this.pos1.z));
		if (!block) throw new Error("Failed to get trapdoor block for stasis chamber");
		if (!block.name.includes("trapdoor") || block.name === "iron_trapdoor") throw new Error("No valid trapdoor found above the stasis chamber");
		return block;
	}

	/**
	 * Get all ender pearls currently in the bounding box of the chamber
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
	 * Serialize the chamber to JSON
	 */
	public toJSON() {
		if (!this.owner.uuid) throw new Error("Failed to determine owner UUID for stasis chamber");
		return {
			dimension: Bot.instance.game.dimension,
			observer: Bot.instance.player.uuid,
			owner: this.owner.uuid,
			server: [ Bot.instance._client.socket.remoteAddress, Bot.instance._client.socket.remotePort ].filter(Boolean).join(":"),
			x: this.block.position.x,
			y: this.block.position.y,
			z: this.block.position.z,
			createdAt: this.createdAt,
			id: this.id
		};
	}
	
}