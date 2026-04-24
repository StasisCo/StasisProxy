import type { Dimension } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import z from "zod";
import { Client } from "~/class/Client";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { type Stasis as StasisData } from "../generated/prisma/client";
import { Pearl } from "./Pearl";
import { StasisColumn } from "./StasisColumn";

export class Stasis extends StasisColumn implements StasisData {

	/**
	 * Finds a stasis instance based on a position, block, pearl, or entity within it
	 * @param search - A Vec3, Block, Entity, or Pearl to find the stasis for
	 * @returns A Stasis instance if a valid stasis was found at the given location, or null if not
	 */
	public static async from(search: Block | Entity | Pearl | Vec3) {

		// Extract the position from the input, whether it's a Vec3 or a Pearl entity
		const position =
			("x" in search && "y" in search && "z" in search) ? search as Vec3 :
				search instanceof Pearl ? search.entity.position as Vec3 :
					"position" in search ? search.position as Vec3 : null;
					
		// If we couldn't get a position from the input, return null
		if (!position) return null;
					
		// Search the world for a stasis bounding box at the given position
		const column = this.get(position);
		if (!column) return null;
		
		// Lookup the stasis in the database
		return await prisma.stasis.findUnique({
			where: {
				position: {
					server: Client.host,
					dimension: Client.bot.game.dimension,
					x: column.block.position.x,
					y: column.block.position.y,
					z: column.block.position.z
				}
			}
		}).then(data => data ? new Stasis(data) : null);

	}

	/**
	 * Fetch all stasis chambers associated with a player from the database, filter them to only include stasis chambers that are still valid and within a certain distance, and return them as Stasis instances.
	 * @param player - The player to fetch stasis chambers for
	 * @returns An array of Stasis instances representing the player's valid stasis chambers within range
	 */
	public static async fetch(player: string) {
		
		const stasis = await prisma.stasis.findMany({
			where: {
				server: Client.host,
				ownerId: player
			}
		}).then(function(results) {
			const all = [];
			for (const data of results) {
				try {
					all.push(new Stasis(data));
				} catch {
				}
			}
			return all;
		});

		// Only keep stasis that have pearls and are within range
		return stasis;

	}

	/** The ID of the stasis, which is a unique identifier for the stasis in the database */
	public readonly id: string;

	/** The date and time when the stasis was created */
	public readonly createdAt: Date;

	/** The dimension the stasis is located in (e.g. "overworld", "the_nether", "the_end") */
	public readonly dimension: Dimension;

	/** The UUID of the player who owns the stasis */
	public readonly ownerId: string;

	/** The server the stasis is located on */
	public readonly server: string;

	/** The X coordinate of the stasis block */
	public readonly x: number;

	/** The Y coordinate of the stasis block */
	public readonly y: number;

	/** The Z coordinate of the stasis block */
	public readonly z: number;

	/**
	 * Creates a new Stasis instance from a Stasis object retrieved from the database
	 * @param data - The Stasis data object retrieved from the database
	 */
	constructor(data: StasisData) {
		super(data.x, data.y, data.z);
		this.id = data.id;
		this.createdAt = data.createdAt;
		this.dimension = z.enum([ "overworld", "the_nether", "the_end" ]).parse(data.dimension);
		this.ownerId = data.ownerId;
		this.server = data.server;
		this.x = data.x;
		this.y = data.y;
		this.z = data.z;
	}

	/**
	 * Get the block to interact with to activate the stasis
	 * @returns {Block} the block to interact with, or null if the block is not loaded or not a valid trigger
	 */
	public override get block(): Block {
		const block = Client.bot.blockAt(new Vec3(this.x, this.y, this.z));
		if (!block) throw new Error(`Stasis block at ${ this.x }, ${ this.y }, ${ this.z } is not loaded`);
		if (!Stasis.isTriggerBlock(block)) throw new Error(`Block at ${ this.x }, ${ this.y }, ${ this.z } is not a valid stasis trigger`);
		return block;
	}

	/**
	 * Enqueue a stasis to be activated
	 */
	public enqueue(mode?: Parameters<typeof StasisManager.enqueue>[1]) {
		return StasisManager.enqueue(this, mode);
	}

	/**
	 * Remove this stasis from the database
	 * @returns {Promise<boolean>} whether the removal was successful
	 */
	public async remove(): Promise<boolean> {
		return await prisma.stasis.delete({ where: { id: this.id }})
			.then(() => true)
			.catch(() => false);
	}

	/**
	 * Interact with the stasis by activating the trapdoor block.
	 * Sends the block_place packet directly because mineflayer's
	 * activateBlock hangs on lookAt when physics is disabled.
	 * Resolves once the server confirms the block state changed, or rejects on timeout.
	 * @returns {Promise<boolean>} whether the interaction was successful (i.e. the block state changed)
	 */
	public interact(): Promise<boolean> {
		const pos = this.block.position;
		if (this.state.open === false) return Promise.resolve(true);

		// Force-look at the block center (resolves immediately)
		const delta = (pos.offset(0.5, 0.5, 0.5) as Vec3).minus(Client.bot.entity.position.offset(0, Client.bot.entity.height, 0) as Vec3);
		Client.bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
		Client.bot.entity.pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));

		// Listen for the raw block_change packet at this position
		const promise = new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				Client.bot._client.removeListener("block_change", onBlockChange);
				resolve(false);
			}, Math.max(Client.bot._client.latency * 2, 500) + 500);

			const onBlockChange = (packet: { location: { x: number; y: number; z: number } }) => {
				if (packet.location.x === pos.x && packet.location.y === pos.y && packet.location.z === pos.z) {
					Client.bot._client.removeListener("block_change", onBlockChange);
					clearTimeout(timeout);
					resolve(this.state.open === false);
				}
			};

			Client.bot._client.on("block_change", onBlockChange);
		});

		// A failed first click can be caused by client/server sneak desync.
		Client.bot._client.write("entity_action", {
			entityId: Client.bot.entity.id,
			actionId: 1,
			jumpBoost: 0
		});

		// Send block_place with version-appropriate fields
		if (Client.bot.supportFeature("blockPlaceHasInsideBlock")) {
			Client.bot._client.write("block_place", {
				location: pos,
				direction: 1,
				hand: 0,
				cursorX: 0.5,
				cursorY: 0.5,
				cursorZ: 0.5,
				insideBlock: false,
				sequence: 0,
				worldBorderHit: false
			});
		} else if (Client.bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
			Client.bot._client.write("block_place", {
				location: pos,
				direction: 1,
				hand: 0,
				cursorX: 0.5,
				cursorY: 0.5,
				cursorZ: 0.5
			});
		} else if (Client.bot.supportFeature("blockPlaceHasHandAndIntCursor")) {
			Client.bot._client.write("block_place", {
				location: pos,
				direction: 1,
				hand: 0,
				cursorX: 8,
				cursorY: 8,
				cursorZ: 8
			});
		}

		Client.bot.swingArm(undefined);

		return promise;
	}

}