import chalk from "chalk";
import { pick } from "lodash";
import type { Dimension, Player } from "mineflayer";
import type { Block } from "prismarine-block";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import z from "zod";
import { Client } from "~/app/Client";
import { STASIS_DISTANCE_MAX } from "~/config";
import type { Stasis as PrismaStasis } from "~/generated/prisma/client";
import { prisma } from "~/prisma";
import { Logger } from "~/util/Logger";
import { Goal } from "./Goal";
import type { Pearl } from "./Pearl";

export class Stasis<Resolved extends boolean = false> implements Omit<PrismaStasis, "x" | "y" | "z" | "ownerId" | "createdAt" | "id"> {

	private static logger = new Logger(chalk.hex("#00c5b5")("STASIS"));

	/**
	 * Checks if a block is a valid stasis trigger (a trapdoor that isn't made of iron)
	 * @param block - The block to check
	 * @returns whether the block is a valid stasis trigger
	 */
	public static isTriggerable(block: Block) {
		if (!block.name.includes("trapdoor")) return false;
		if (block.name === "iron_trapdoor") return false;
		return true;
	}

	/**
	 * Returns the bounding box of a stasis given a position inside it.
	 * @param position - A position inside the stasis to get the bounds for
	 * @returns The top and bottom positions of the stasis bounding box, or null if no valid stasis was found
	 */
	public static getBounds(position: Vec3) {

		const bottomY = "minY" in Client.bot.game && typeof Client.bot.game.minY === "number" ? Client.bot.game.minY : -64;
		const height = "height" in Client.bot.game && typeof Client.bot.game.height === "number" ? Client.bot.game.height : 384;

		// Walk down from the starting position until we find the soul sand at the bottom
		let soulSandY = position.y;
		while (soulSandY >= bottomY) {
			const block = Client.bot.blockAt(new Vec3(position.x, soulSandY, position.z));
			if (!block) return null; // Chunk not loaded yet
			if (block.name === "soul_sand") break;
			soulSandY--;
		}

		// Walk up from the soul sand until we find the top bubble column block
		let trapdoorY = soulSandY;
		while (trapdoorY <= bottomY + height) {
			const block = Client.bot.blockAt(new Vec3(position.x, trapdoorY, position.z));
			if (!block) return null; // Chunk not loaded yet
			if (block.name.includes("trapdoor")) break;
			trapdoorY++;
		}

		const top = Client.bot.blockAt(new Vec3(position.x, trapdoorY, position.z));
		if (!top || !this.isTriggerable(top)) return null;
		
		const bottom = Client.bot.blockAt(new Vec3(position.x, soulSandY, position.z));
		if (!bottom || bottom.name !== "soul_sand") return null;

		return [
			top.position,
			bottom.position
		] as const;
		
	}

	/**
	 * Fetch all stasis chambers associated with a player from the database, filter them to only include stasis chambers that are still valid and within a certain distance, and return them as Stasis instances.
	 * @param player - The player to fetch stasis chambers for
	 * @returns An array of Stasis instances representing the player's valid stasis chambers within range
	 */
	public static async fetch(player: Pick<Player, "uuid">): Promise<Stasis<true>[]> {
		if (!Client.host) throw new Error("Client host is not set. Cannot query for stasis without server information.");
		const maxDistance = STASIS_DISTANCE_MAX > 0 ? STASIS_DISTANCE_MAX : Infinity;

		const rows = await prisma.stasis.findMany({
			where: {
				server: Client.host,
				ownerId: player.uuid
			}
		});

		// Safely construct stasis instances, skip any whose chunks aren't loaded
		const stasis = rows.reduce<Stasis<true>[]>((acc, row) => {
			try {
				acc.push(new Stasis<true>(row));
			} catch { /* chunk not loaded / invalid bounds */ }
			return acc;
		}, []);

		// Only keep stasis that have pearls and are within range
		const valid = stasis
			.filter(s => s.entities.length > 0)
			.filter(s => s.entities.some(e => e.position.distanceTo(Client.bot.entity.position) <= maxDistance));

		// Deduplicate by position, removing extras from the database
		const unique = new Map<string, Stasis<true>>();
		for (const s of valid) {
			const key = `${ s.block.position.x },${ s.block.position.y },${ s.block.position.z }`;
			if (unique.has(key)) await s.remove();
			else unique.set(key, s);
		}

		return [ ...unique.values() ];

	}

	/**
	 * Finds a stasis chamber in world based on a pearl
	 * @param pearl 
	 * @returns A Stasis instance if a valid stasis chamber was found for the pearl, or null if no stasis chamber was found
	 */
	public static from(pearl: Pearl): Stasis | null {

		if (!Client.host) throw new Error("Client host is not set. Cannot query for stasis without server information.");

		// Get the bounding box of the stasis chamber the pearl is in
		const bounds = Stasis.getBounds(pearl.entity.position as Vec3);
		if (!bounds) return null;

		return new Stasis({
			dimension: Client.bot.game.dimension,
			server: Client.host,
			x: bounds[0].x,
			y: bounds[0].y,
			z: bounds[0].z
		});

	}

	/**
	 * ID of the stasis, corresponding to the ID in the database
	 */
	public readonly id: Resolved extends true ? string : undefined;

	/**
	 * The date and time when the stasis was created
	 */
	public readonly createdAt: Resolved extends true ? Date : undefined;

	/**
	 * The dimension the stasis is located in (e.g. "overworld", "the_nether", "the_end")
	 */
	public readonly dimension: Dimension;

	/**
	 * The UUID of the player who created the stasis
	 */
	public readonly ownerId: Resolved extends true ? string : undefined;

	/**
	 * The server the stasis is located on (e.g. "play.hypixel.net")
	 */
	public readonly server: string;

	/**
	 * The top position of the stasis bounding box
	 */
	public readonly pos1: Vec3;

	/**
	 * The bottom position of the stasis bounding box
	 */
	public readonly pos2: Vec3;
	
	/**
	 * Get the block to interact with to activate the stasis
	 * @returns {Block} The trapdoor block
	 */
	public get block(): Block {
		const block = Client.bot.blockAt(this.pos1);
		if (!block) throw new Error("Failed to find block at stasis trigger position");
		if (!Stasis.isTriggerable(block)) throw new Error("Block at stasis trigger position is not a valid trigger");
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

	private constructor(stasis: Resolved extends true ? PrismaStasis : Omit<PrismaStasis, "id" | "createdAt" | "ownerId"> & Partial<Pick<PrismaStasis, "id" | "createdAt" | "ownerId">>) {
		this.id = stasis.id as Resolved extends true ? string : undefined;
		this.createdAt = stasis.createdAt as Resolved extends true ? Date : undefined;
		this.dimension = z.enum([ "overworld", "the_nether", "the_end" ]).parse(stasis.dimension);
		this.ownerId = stasis.ownerId as Resolved extends true ? string : undefined;
		this.server = stasis.server;
		const bounds = Stasis.getBounds(new Vec3(stasis.x, stasis.y, stasis.z));
		if (!bounds) throw new Error("Failed to find stasis blocks at stasis position");
		this.pos1 = bounds[0];
		this.pos2 = bounds[1];
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
	 * Resolve the stasis by fetching missing information from the database. 
	 * This is necessary for stasis instances that were created with partial information (e.g. from a pearl or position) 
	 * to fill in details like the owner and creation date that are required for certain operations but aren't available from the pearl or position alone.
	 * @returns a new Stasis instance with all information filled in
	 */
	public async resolve(): Promise<Stasis<true> | null> {
		return await prisma.stasis.findUniqueOrThrow({
			where: { position: {
				server: this.server,
				dimension: this.dimension,
				x: this.block.position.x,
				y: this.block.position.y,
				z: this.block.position.z
			}}
		})
			.then(stasis => Object.assign(this, pick(stasis, [ "id", "createdAt", "ownerId" ])) as Stasis<true>)
			.catch(() => null);
	}

	/**
	 * Save this stasis to the database, associating it with the given owner. This is necessary for stasis instances that were created from 
	 * a pearl or position and don't have an owner or ID yet, to persist them in the database and make them retrievable in the future.
	 * @param owner 
	 * @returns a new Stasis instance with the ID and owner information filled in from the database
	 */
	public async save(owner: Player): Promise<Stasis<true>> {

		if (!Client.host) throw new Error("Client host is not set. Cannot save stasis without server information.");
		if (!owner?.uuid) throw new Error("Cannot save stasis: pearl owner UUID is missing");

		const ownerId = owner.uuid;
		const ownerName = owner.username?.trim().length ? owner.username : ownerId;

		await prisma.player.upsert({
			where: { id: ownerId },
			update: { username: ownerName },
			create: { id: ownerId, username: ownerName }
		});

		const saved = await prisma.stasis.upsert({
			where: {
				position: {
					server: Client.host,
					dimension: this.dimension,
					x: this.block.position.x,
					y: this.block.position.y,
					z: this.block.position.z
				}
			},
			update: {
				ownerId
			},
			create: {
				server: Client.host,
				dimension: this.dimension,
				x: this.block.position.x,
				y: this.block.position.y,
				z: this.block.position.z,
				ownerId
			}
		});

		return Object.assign(this, pick(saved, [ "id", "createdAt", "ownerId" ])) as Stasis<true>;

	}

	/**
	 * Interact with the stasis by activating the trapdoor block.
	 * Sends the block_place packet directly because mineflayer's
	 * activateBlock hangs on lookAt when physics is disabled.
	 * Resolves once the server confirms the block state changed, or rejects on timeout.
	 */
	private interactOnce(): Promise<boolean> {
		const block = this.block;
		const pos = block.position;

		// Force-look at the block center (resolves immediately)
		const delta = (pos.offset(0.5, 0.5, 0.5) as Vec3).minus(Client.bot.entity.position.offset(0, Client.bot.entity.height, 0) as Vec3);
		Client.bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
		Client.bot.entity.pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z));

		// Listen for the raw block_change packet at this position
		const promise = new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				Client.bot._client.removeListener("block_change", onBlockChange);
				Stasis.logger.warn(`Trapdoor interaction timed out at ${ pos }`);
				resolve(false);
			}, 5000);

			const onBlockChange = (packet: { location: { x: number; y: number; z: number } }) => {
				if (packet.location.x === pos.x && packet.location.y === pos.y && packet.location.z === pos.z) {
					Client.bot._client.removeListener("block_change", onBlockChange);
					clearTimeout(timeout);
					resolve(true);
				}
			};

			Client.bot._client.on("block_change", onBlockChange);
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

	public async interact(): Promise<boolean> {
		const interacted = await this.interactOnce();
		if (interacted) return true;

		// A failed first click can be caused by client/server sneak desync.
		Client.bot._client.write("entity_action", {
			entityId: Client.bot.entity.id,
			actionId: 1,
			jumpBoost: 0
		});

		Stasis.logger.warn(`Retrying trapdoor interaction after unsneak at ${ this.block.position }`);
		return await this.interactOnce();
	}

	private waitForPearlBreak(initialPearlIds: Set<number>): Promise<boolean> {
		if (initialPearlIds.size === 0) {
			Stasis.logger.warn(`No pearls found in stasis chamber at ${ this.block.position }`);
			return Promise.resolve(false);
		}

		return new Promise<boolean>(resolve => {
			const timeout = setTimeout(() => {
				Client.bot.removeListener("entityGone", onEntityGone);
				Stasis.logger.warn(`Timed out waiting for pearl break at ${ this.block.position }`);
				resolve(false);
			}, 5000);

			const onEntityGone = (entity: Entity) => {
				if (!initialPearlIds.has(entity.id)) return;

				const remaining = this.entities.filter(pearl => initialPearlIds.has(pearl.id));
				if (remaining.length >= initialPearlIds.size) return;

				Client.bot.removeListener("entityGone", onEntityGone);
				clearTimeout(timeout);
				resolve(true);
			};

			Client.bot.on("entityGone", onEntityGone);
		});
	}

	/**
	 * Enqueue a goal stasis
	 */
	public enqueue(mode: "online" | "offline" = "online") {

		// Initialize the goal
		const goal = new Goal(this.block.position).setRange(5.0);
		
		switch (mode) {
			
			// Online mode
			case "online":
				goal.once("arrived", async() => {
					
					// Check the player is still online (players is keyed by username, owner is a UUID)
					const owner = this.ownerId && Object.values(Client.bot.players).find(p => p.uuid === this.ownerId);
					if (!owner) return;
					const pearlIds = new Set(this.entities.map(entity => entity.id));

					// Interact with the stasis and wait for confirmation
					const interacted = await this.interact();
					if (!interacted) return;

					await this.waitForPearlBreak(pearlIds);

				});
				break;

			// Offline mode
			case "offline":
				goal.once("arrived", async() => {

					Stasis.logger.log("Waiting for owner to join...");

					// Wait for the owner to appear in an add_player player_info packet
					const joined = await new Promise<boolean>(resolve => {
						const timeout = setTimeout(() => {
							Client.bot._client.removeListener("packet", onPacket);
							Stasis.logger.warn("Timed out waiting for owner to join");
							resolve(false);
						}, 70000);

						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol packet
						const onPacket = (data: any, meta: { name: string }) => {
							if (meta.name !== "player_info") return;

							// Newer (1.19.3+): action is a bitmask object; Legacy: action is a string
							const isAddPlayer = typeof data.action === "string"
								? data.action === "add_player"
								: data.action?.add_player === true;
							if (!isAddPlayer) return;

							// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol entry
							if (!data.data?.some((entry: any) => entry.uuid === this.ownerId)) return;

							Client.bot._client.removeListener("packet", onPacket);
							clearTimeout(timeout);
							resolve(true);
						};

						Client.bot._client.on("packet", onPacket);
					});

					if (!joined) return;
					const pearlIds = new Set(this.entities.map(entity => entity.id));

					const interacted = await this.interact();
					if (!interacted) return;

					await this.waitForPearlBreak(pearlIds);

				});
				break;

		}

		Client.pathfinding.pushGoal(goal);

	}

}