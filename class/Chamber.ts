import { type Chamber as ChamberRecord } from "@prisma/client";
import type { Dimension } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { prisma } from "..";
import { Bot } from "./Bot";

export class Chamber {

	protected readonly host: string;
	
	protected readonly level: Dimension;

	public constructor(protected readonly pos1: Vec3, protected readonly pos2: Vec3) {
		this.level = Bot.bot.game.dimension;
		this.host = [ Bot.bot._client.socket.remoteAddress, Bot.bot._client.socket.remotePort ].join(":");
	}

	/**
     * Gets the chamber from a block that is part of the chamber
     * @param position - A block position that is part of the chamber
     * @returns {Chamber} The chamber instance or null if not found
     */
	public static fromBlockPosition(position: Vec3): Chamber | null {

		// Walk up to find the top of the bubble column
		let startPos = position.y;
		while (true) {
			const block = Bot.bot.blockAt(new Vec3(position.x, startPos, position.z));
			if (!block) break;
			if (block.name === "bubble_column") startPos++;
			else break;
		}

		// Detect the bubble column
		let columnTop;
		let columnBottom;
		for (let y = startPos; y >= -64; y--) {
			const block = Bot.bot.blockAt(new Vec3(position.x, y, position.z));
			if (!block) continue;
			if (block.name === "bubble_column" && !columnTop) columnTop = block;
			if (block.name === "soul_sand") {
				columnBottom = block;
				break;
			}
		}

		if (!columnTop || !columnBottom) return null;
		return new Chamber(columnBottom.position, columnTop.position);

	}

	/**
	 * Gets the chamber from a database record
	 * @param record - A chamber record from the database
	 * @returns {Chamber} The chamber instance
	 */
	public static from(record: ChamberRecord): Chamber | null {
		return Chamber.fromBlockPosition(new Vec3(record.x, record.y, record.z));
	}

	/**
     * Get all ender pearls currently in the bounding box of the chamber
	 * @returns {Entity[]} An array of ender pearl entities
     */
	public getOccupants(): Entity[] {
		return Object.values(Bot.bot.entities)
			.filter(e => e.type === "projectile" && e.name === "ender_pearl")
			.filter(e => Bot.bot.blockAt(e.position)?.position.x === this.pos1.x)
			.filter(e => Bot.bot.blockAt(e.position)?.position.z === this.pos1.z)
			.filter(e => Bot.bot.blockAt(e.position)?.position.y || 0 <= Math.min(this.pos1.y, this.pos2.y))
			.filter(e => Bot.bot.blockAt(e.position)?.position.y || 0 >= Math.max(this.pos1.y, this.pos2.y));
	}
	
	/**
     * Check if the chamber is occupied by an ender pearl
	 * @returns {boolean} True if occupied, false otherwise
     */
	public isOccupied(): boolean {
		return this.getOccupants().length > 0;
	}

	/**
     * Get the interaction block (trapdoor) of the chamber
	 * @returns {Block} The block that should be interacted with to activate the chamber, or null if not found
     */
	public getInteractionBlock(): Block | null {
		const block = Bot.bot.blockAt(new Vec3(this.pos1.x, Math.max(this.pos1.y, this.pos2.y) + 1, this.pos1.z));
		if (!block || !block.name.includes("trapdoor") || block.name === "iron_trapdoor") return null;
		return block;
	}

	/**
     * Get the owner of the chamber
	 * @returns {Entity} The player entity that owns the chamber, or null if not found
     */
	public async getOwner(): Promise<Entity | null> {
		const interactionBlock = this.getInteractionBlock();
		if (!interactionBlock) return null;
		return await prisma.chamber.findFirst({ where: {
			world: `${ Bot.bot._client.socket.remoteAddress }:${ Bot.bot._client.socket.remotePort || 25565 }+${ Bot.bot.game.dimension };${ process.env.LOCATION_KEY || "default" }`,
			x: interactionBlock.position.x,
			y: interactionBlock.position.y,
			z: interactionBlock.position.z
		}}).then(pearl => pearl?.ownerUUID ? Object.values(Bot.bot.entities).find(e => e.type === "player" && e.uuid === pearl.ownerUUID) || null : null);
	}

}