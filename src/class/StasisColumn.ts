import type { Player } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import z from "zod";
import { Client } from "~/class/Client";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { Pearl } from "./Pearl";
import { Stasis, STASIS_OWNER_INCLUDE } from "./Stasis";

export class StasisColumn {

	/**
     * Checks if a block is a valid stasis trigger (a trapdoor that isn't made of iron)
     * @param block - The block to check
     * @returns whether the block is a valid stasis trigger
     */
	public static isTriggerBlock(block: Block) {
		if (!block.name.includes("trapdoor")) return false;
		if (block.name === "iron_trapdoor") return false;
		return true;
	}

	/**
     * Returns the bounding box of a stasis given a position inside it.
     * @param pos - A position inside the stasis to get the bounds for
     * @returns The top and bottom positions of the stasis bounding box, or null if no valid stasis was found
     */
	public static getBoundingBox(position: Vec3) {

		const pos = position.floored();
    
		const bottomY = "minY" in Client.bot.game && typeof Client.bot.game.minY === "number" ? Client.bot.game.minY : -64;
		const height = "height" in Client.bot.game && typeof Client.bot.game.height === "number" ? Client.bot.game.height : 384;
        
		// Walk down from the starting position until we find the soul sand at the bottom
		let soulSandY = pos.y;
		while (soulSandY >= bottomY) {
			const block = Client.bot.blockAt(new Vec3(pos.x, soulSandY, pos.z));
			if (!block) return null; // Chunk not loaded yet
			if (block.name === "soul_sand") break;
			soulSandY--;
		}
    
		// Walk up from the soul sand until we find the top bubble column block
		let trapdoorY = soulSandY;
		while (trapdoorY <= bottomY + height) {
			const block = Client.bot.blockAt(new Vec3(pos.x, trapdoorY, pos.z));
			if (!block) return null; // Chunk not loaded yet
			if (StasisColumn.isTriggerBlock(block)) break;
			trapdoorY++;
		}
    
		return {
			pos1: new Vec3(pos.x, soulSandY, pos.z),
			pos2: new Vec3(pos.x, trapdoorY, pos.z)
		};
            
	}

	/**
     * Finds a stasis instance based on a position, block, pearl, or entity within it
     * @param search - A Vec3, Block, Entity, or Pearl to find the stasis for
     * @returns A Stasis instance if a valid stasis was found at the given location, or null if not
     */
	public static get(search: Block | Entity | Pearl | Vec3) {
    
		// Extract the position from the input, whether it's a Vec3 or a Pearl entity
		const position =
			("x" in search && "y" in search && "z" in search) ? search as Vec3 :
				search instanceof Pearl ? search.entity.position as Vec3 :
					"position" in search ? search.position as Vec3 : null;

		// If we couldn't get a position from the input, return null
		if (!position) return null;
    
		// Search the world for a stasis bounding box at the given position
		const bounds = this.getBoundingBox(position);
		if (!bounds) return null;
            
		try {
			return new StasisColumn(position.x, position.y, position.z);
		} catch {
			return null;
		}
    
	}

	/** The bottom position of the stasis column bounding box (the soul sand block) */
	public readonly pos1: Vec3;

	/** The top position of the stasis column bounding box (the trapdoor block) */
	public readonly pos2: Vec3;

	protected constructor(x: number, y: number, z: number) {
		const box = StasisColumn.getBoundingBox(new Vec3(x, y, z));
		if (!box) throw new Error(`No valid stasis column found at position (${ x }, ${ y }, ${ z })`);
		this.pos1 = box.pos1;
		this.pos2 = box.pos2;
	}

	/**
	 * Get the block to interact with to activate the stasis
	 * @returns {Block} The trapdoor block
	 */
	public get block(): Block {
		const block = [ this.pos1, this.pos2 ].map(pos => Client.bot.blockAt(pos)).find(block => block && StasisColumn.isTriggerBlock(block));
		if (!block) throw new Error("Failed to find block at stasis trigger position");
		if (!StasisColumn.isTriggerBlock(block)) throw new Error("Block at stasis trigger position is not a valid trigger");
		return block;
	}

	/**
     * Get all ender pearls currently in the bounding box of the stasis
     * @returns {Entity[]} An array of ender pearl entities
     */
	public get entities(): Entity[] {
		return Object.values(Client.bot.entities)
			.filter(e => e.type === "projectile" && e.name === "ender_pearl")
			.filter(e => Math.floor(e.position.x) >= Math.min(this.pos1.x, this.pos2.x) && Math.floor(e.position.x) <= Math.max(this.pos1.x, this.pos2.x))
			.filter(e => Math.floor(e.position.z) >= Math.min(this.pos1.z, this.pos2.z) && Math.floor(e.position.z) <= Math.max(this.pos1.z, this.pos2.z))
			.filter(e => e.position.floored().y || 0 <= Math.min(this.pos1.y, this.pos2.y))
			.filter(e => e.position.floored().y || 0 >= Math.max(this.pos1.y, this.pos2.y));
	}
    
	/**
     * Get all Pearl instances currently in the stasis, based on the entities in its bounding box
     * @returns {Pearl[]} An array of Pearl instances representing the pearls currently in the stasis
     */
	public get pearls(): Pearl[] {
		const entities = this.entities;
		return entities.map(e => StasisManager.pearls.get(e.id)).filter((p): p is Pearl => !!p);
	}

	/**
     * Get the current state of the trigger block of the stasis
     */
	public get state() {
		const block = this.block;
		return z.object({
			open: z.boolean(),
			waterlogged: z.boolean(),
			powered: z.boolean(),
			facing: z.enum([ "north", "south", "east", "west" ]),
			half: z.enum([ "top", "bottom" ])
		}).parse(block.getProperties());
	}
    
	/**
     * Saves the stasis to the database, associating it with the given player as the owner. 
     * If a stasis already exists at this location, it will be updated with the new owner. If not, a new stasis will be created.
     * @param owner The player to associate as the owner of this stasis
     * @returns { Promise<Stasis | null> }A Stasis instance representing the saved stasis from the database, or null if the operation failed
     */
	public async save(owner: Player): Promise<Stasis | null> {
		try {
			const player = await prisma.player.upsert({
				where: {
					server_player: {
						uuid: owner.uuid,
						server: Client.host
					}
				},
				create: {
					uuid: owner.uuid,
					username: owner.username,
					server: Client.host
				},
				update: {
					username: owner.username
				}
			});

			return await prisma.stasis.upsert({
				where: {
					position: {
						dimension: Client.bot.game.dimension,
						server: Client.host,
						x: this.block.position.x,
						y: this.block.position.y,
						z: this.block.position.z
					}
				},
				update: {
					ownerId: player.id
				},
				create: {
					dimension: Client.bot.game.dimension,
					server: Client.host,
					x: this.block.position.x,
					y: this.block.position.y,
					z: this.block.position.z,
					ownerId: player.id
				},
				include: STASIS_OWNER_INCLUDE
			}).then(data => new Stasis(data));
		} catch (e) {
			console.error("Failed to save stasis to database", e);
			return null;
		}
	}

	/** Get the surface Y level of the stasis, which is the Y level of the first water source block or waterlogged block within the bounding box, or the bottom Y level if no water is found. This is used to determine where pearls will surface when they are teleported to the stasis.
	 * @returns {number} The surface Y level of the stasis
	 */
	public get surfaceY() {
		
		// Traverse down until we find the first water, bubble column, or waterlogged block
		for (let y = this.pos2.y; y >= this.pos1.y; y--) {
			const block = Client.bot.blockAt(new Vec3(this.pos1.x, y, this.pos1.z));
			if (!block) continue; // Chunk not loaded yet
			const props = block.getProperties() as Record<string, unknown>;
			if (block.name === "water" || block.name === "bubble_column" || props.waterlogged === true) {
				return y;
			}
		}

		return this.pos1.y;

	}
	
}