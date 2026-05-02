import chalk from "chalk";
import type { Dimension } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import z from "zod";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { prisma } from "~/prisma";
import { type Stasis as StasisData } from "../generated/prisma/client";
import { Pearl } from "./Pearl";
import { StasisColumn } from "./StasisColumn";

export class Stasis extends StasisColumn<{

	/**
	 * Emitted when a new stasis is being tracked by the manager, either through creation or discovery of an existing stasis in the world
	 * @param stasis The stasis that was added
	 */
	"add": [ Stasis ];

	/**
	 * Emitted when a stasis is removed from the manager, either through deletion or loss of the stasis block
	 * @param stasis The stasis that was removed
	 */
	"remove": [ Stasis ];

}> implements StasisData {

	/** A map of all stasis instances currently tracked by the manager, keyed by their unique ID */
	public static readonly instances = new Map<string, Stasis>();

	/**
	 * Materializes a Stasis instance from a StasisData object retrieved from the database. 
	 * If an instance with the same ID already exists, it returns the existing instance instead of creating a new one.
	 * @param data - The StasisData object retrieved from the database
	 * @returns A Stasis instance corresponding to the given data
	 */
	private static materialize(data: StasisData): Stasis {
		const existing = Stasis.instances.get(data.id);
		if (existing) return existing;
		return new Stasis(data);
	}

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
		try {
			if (!MinecraftClient.host) throw new Error("Client host is not defined");
			return await prisma.stasis.findUnique({
				where: {
					position: {
						server: MinecraftClient.host,
						dimension: MinecraftClient.bot.game.dimension,
						x: column.block.position.x,
						y: column.block.position.y,
						z: column.block.position.z
					}
				},
				include: {
					owner: {
						select: {
							id: true,
							username: true,
							createdAt: true
						}
					}
				}
			}).then(data => data ? Stasis.materialize(data) : null);
		} catch {
			return null;
		}

	}

	/**
	 * Fetch all stasis chambers associated with a player from the database, filter them to only include stasis chambers that are still valid and within a certain distance, and return them as Stasis instances.
	 * @param player - The player to fetch stasis chambers for
	 * @returns An array of Stasis instances representing the player's valid stasis chambers within range
	 */
	public static async fetch(player: string) {
		
		const stasis = await prisma.stasis.findMany({
			where: {
				server: MinecraftClient.host,
				owner: {
					id: player
				},
				dimension: MinecraftClient.bot.game.dimension
			},
			include: {
				owner: {
					select: {
						id: true,
						username: true,
						createdAt: true
					}
				}
			}
		}).then(function(results) {
			const all = [];
			for (const data of results) {
				try {
					all.push(Stasis.materialize(data));
				} catch {
				}
			}
			return all.filter(stasis => stasis.pearls.length > 0);
		});

		// Only keep stasis that have pearls and are within range
		return stasis;

	}

	/** The ID of the stasis, which is a unique identifier for the stasis in the database */
	public readonly id: string;

	/** The date and time when the stasis was created */
	public readonly createdAt: Date;

	public readonly updatedAt: Date;

	/** The dimension the stasis is located in (e.g. "overworld", "the_nether", "the_end") */
	public readonly dimension: Dimension;

	/** The Minecraft UUID of the player who owns the stasis */
	public readonly ownerId: string;

	/** The ID of the bot associated with the stasis, if any */
	public botId: string | null;

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
		this.createdAt = data.createdAt;
		this.dimension = z.enum([ "overworld", "the_nether", "the_end" ]).parse(data.dimension);
		this.id = data.id;
		this.ownerId = data.ownerId;
		this.botId = data.botId;
		this.server = data.server;
		this.updatedAt = data.updatedAt;
		this.x = data.x;
		this.y = data.y;
		this.z = data.z;
		Stasis.instances.set(this.id, this);
		void this.claimManagement();
		this.emit("add", this);
		
	}

	/**
	 * Claims management of this stasis for the current bot by setting the botId in the database. 
	 * This allows the bot to track and manage the stasis, and ensures that only one bot manages a given stasis at a time. 
	 * If the stasis is already managed by another bot, it will update to be managed by this bot instead.
	 */
	private async claimManagement() {
		const rawBotId = MinecraftClient.bot.player?.uuid;
		if (!rawBotId) return;

		const botId = rawBotId.replace(/([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})/, "$1-$2-$3-$4-$5");
		if (this.botId === botId) return;

		await prisma.stasis.update({
			where: {
				id: this.id
			},
			data: {
				botId
			}
		});

		this.botId = botId;
	}

	/**
	 * Releases management of this stasis for the current bot by setting the botId in the database to null.
	 * This allows other bots to manage the stasis if needed.
	 */
	public async releaseManagement() {
		if (this.botId === null) return;
		await prisma.stasis.update({
			where: {
				id: this.id
			},
			data: {
				botId: null
			}
		}).catch(() => {});
		this.botId = null;
	}

	/**
	 * Get the block to interact with to activate the stasis
	 * @returns {Block} the block to interact with, or null if the block is not loaded or not a valid trigger
	 */
	public override get block(): Block {
		const block = MinecraftClient.bot.blockAt(new Vec3(this.x, this.y, this.z));
		if (!block) throw new Error(`Stasis block at ${ this.x }, ${ this.y }, ${ this.z } is not loaded`);
		if (!Stasis.isTriggerBlock(block)) throw new Error(`Block at ${ this.x }, ${ this.y }, ${ this.z } is not a valid stasis trigger`);
		return block;
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
		const delta = (pos.offset(0.5, 0.5, 0.5) as Vec3).minus(MinecraftClient.bot.entity.position.offset(0, MinecraftClient.bot.entity.height, 0) as Vec3);
		MinecraftClient.bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
		MinecraftClient.bot.entity.pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));

		StasisManager.expectedInteractions.set(this, Date.now());

		// Listen for the raw block_change packet at this position
		const promise = new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				MinecraftClient.bot._client.removeListener("block_change", onBlockChange);
				resolve(false);
			}, Math.max(MinecraftClient.bot._client.latency * 2, 500) + 500);

			const onBlockChange = (packet: { location: { x: number; y: number; z: number } }) => {
				if (packet.location.x === pos.x && packet.location.y === pos.y && packet.location.z === pos.z) {
					MinecraftClient.bot._client.removeListener("block_change", onBlockChange);
					clearTimeout(timeout);
					resolve(this.state.open === false);
				}
			};

			MinecraftClient.bot._client.on("block_change", onBlockChange);
		});

		// A failed first click can be caused by client/server sneak desync.
		MinecraftClient.bot._client.write("entity_action", {
			entityId: MinecraftClient.bot.entity.id,
			actionId: 1,
			jumpBoost: 0
		});

		// Send block_place with version-appropriate fields
		if (MinecraftClient.bot.supportFeature("blockPlaceHasInsideBlock")) {
			MinecraftClient.bot._client.write("block_place", {
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
		} else if (MinecraftClient.bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
			MinecraftClient.bot._client.write("block_place", {
				location: pos,
				direction: 1,
				hand: 0,
				cursorX: 0.5,
				cursorY: 0.5,
				cursorZ: 0.5
			});
		} else if (MinecraftClient.bot.supportFeature("blockPlaceHasHandAndIntCursor")) {
			MinecraftClient.bot._client.write("block_place", {
				location: pos,
				direction: 1,
				hand: 0,
				cursorX: 8,
				cursorY: 8,
				cursorZ: 8
			});
		}

		MinecraftClient.bot.swingArm(undefined);

		return promise;
	}

	/**
	 * Activate the stasis by interacting with the trapdoor block. 
	 * This is a higher-level method that includes retries and timeout handling, and returns 
	 * whether the activation was successful (i.e. the block state changed to open).
	 * @param retries - The number of times to retry the interaction if it fails (default: 3)
	 * @param timeoutMs - The maximum time to wait for pearls to break before giving up (default: max of 2x latency or 1000ms)
	 * @returns {Promise<boolean>} whether the activation was successful (all pearls broke)
	 */
	public async activate(retries = 3, timeoutMs = Math.max(MinecraftClient.bot._client.latency * 2, 500) + 500): Promise<boolean> {

		StasisManager.logger.log(`Activating stasis ${ chalk.yellow(this.id) } belonging to player ${ chalk.cyan(this.ownerId) }...`);

		// Snapshot pearls before interacting
		const pearls = this.pearls;

		// Interact with the stasis and retry on failure
		for (let attempt = 1; attempt <= retries; attempt++) {
			const interacted = await this.interact();
			if (interacted) break;
			StasisManager.logger.warn(`Failed to interact with stasis ${ chalk.yellow(this.id) } belonging to player ${ chalk.cyan(this.ownerId) }, attempt ${ chalk.yellow(attempt) }`);
			if (attempt === retries) {
				StasisManager.logger.error(`Failed to interact with stasis ${ chalk.yellow(this.id) } after ${ retries } attempts, aborting activation`);
				return false;
			}
			await new Promise(res => setTimeout(res, 1000));
		}

		// Wait for all pearls to break, with a timeout in case something goes wrong
		const pearlsDestroyed = Promise.all(pearls.map(pearl => new Promise(res => pearl.once("destroyed", res))));
		await Promise.race([ new Promise<void>(resolve => setTimeout(resolve, timeoutMs)), pearlsDestroyed ]);

		return pearls.map(p => p.entity.id).every(id => !StasisManager.pearls.has(id));

	}

}