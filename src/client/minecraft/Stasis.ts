import chalk from "chalk";
import type { Dimension } from "mineflayer";
import type { Block, Shape } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import z from "zod";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { Face, faceToward, type FaceIndex } from "~/client/minecraft/manager/InteractionManager";
import { EYE_HEIGHT } from "~/client/minecraft/manager/RotationManager";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { prisma } from "~/prisma";
import { type Stasis as StasisData } from "../../generated/prisma/client";
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

	/** The ID of the stasis, which is a unique identifier for the stasis in the database */
	public readonly id: string;

	/** The date and time when the stasis was created */
	public readonly createdAt: Date;

	public readonly updatedAt: Date;

	/** The dimension the stasis is located in (e.g. "overworld", "the_nether", "the_end") */
	public readonly dimension: Dimension;

	/** The Minecraft UUID of the player who owns the stasis */
	public readonly ownerId: string;

	/** The IDs of the bots currently managing this stasis */
	public managerIds: string[] = [];

	/** The server the stasis is located on */
	public readonly server: string;

	/** The X coordinate of the stasis block */
	public readonly x: number;

	/** The Y coordinate of the stasis block */
	public readonly y: number;

	/** The Z coordinate of the stasis block */
	public readonly z: number;

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
	public static async from(search: Block | Entity | Pearl | Vec3Like) {

		// Extract the position from the input, whether it's a Vec3 or a Pearl entity
		const position =
			("x" in search && "y" in search && "z" in search) ? search :
				search instanceof Pearl ? search.entity.position :
					"position" in search ? search.position : null;
					
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
	 * Claims management of this stasis for the current bot by connecting it to the managers relation.
	 * Multiple bots can manage a single stasis simultaneously.
	 */
	private async claimManagement() {
		const rawBotId = MinecraftClient.bot.player?.uuid;
		if (!rawBotId) return;

		const botId = rawBotId.replace(/([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})/, "$1-$2-$3-$4-$5");
		if (this.managerIds.includes(botId)) return;

		// Race: the pearl can break/despawn between Stasis row creation and
		// this update completing, removing the row. Prisma raises P2025 in
		// that case — there's nothing to manage, so just drop it.
		try {
			await prisma.stasis.update({
				where: {
					id: this.id
				},
				data: {
					managers: { connect: { id: botId }}
				}
			});

			this.managerIds.push(botId);
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("P2025")) throw err;
		}
	}

	/**
	 * Releases management of this stasis for the current bot by disconnecting it from the managers relation.
	 */
	public async releaseManagement() {
		const rawBotId = MinecraftClient.bot.player?.uuid;
		if (!rawBotId) return;

		const botId = rawBotId.replace(/([0-9a-fA-F]{8})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{4})([0-9a-fA-F]{12})/, "$1-$2-$3-$4-$5");
		if (!this.managerIds.includes(botId)) return;

		await prisma.stasis.update({
			where: {
				id: this.id
			},
			data: {
				managers: { disconnect: { id: botId }}
			}
		}).catch(() => {});

		this.managerIds = this.managerIds.filter(id => id !== botId);
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
	 * Maximum eye-to-hit distance we will attempt an interaction from. Vanilla allows 4.5 blocks
	 * and the server re-checks it; 0.1 of headroom covers the server's view of our position being
	 * a tick behind while we drift at arrival speeds. The old 4.0 was tighter than vanilla and
	 * self-rejected legitimate clicks: a trapdoor sunk below floor level sits 4.1–4.4 from the
	 * eye even with the feet inside the 3.0 goal range.
	 */
	private static readonly INTERACT_REACH = 4.4;

	/**
	 * Work out where to click the trigger block from where the bot is standing.
	 *
	 * Prefers an actual raycast, so the hit point lands on the block's real collision shape — a
	 * closed trapdoor is three pixels thick, so "the middle of the block" is a point in thin air
	 * that no ray from the eye could have produced. The anticheat reconstructs the click from the
	 * rotation we last sent and rejects hit vectors that don't line up with the claimed face,
	 * which is why the old centre-of-block cursor silently never opened anything.
	 *
	 * Falls back to the centre of the face pointing at the bot when the ray is obstructed.
	 * @returns the face to click, the absolute hit position, and the cursor relative to the block
	 */
	private resolveClick(pos: Vec3Like, eye: Vec3Like): { face: FaceIndex; hit: Vec3; cursor: Vec3 } {

		// The union of the block's collision shapes, relative to its minimum corner. A closed
		// trapdoor occupies roughly y 0..0.19 of its block, so this is nowhere near the middle.
		const shapes = (this.block.shapes ?? []) as number[][];
		let minX = 0, minY = 0, minZ = 0, maxX = 1, maxY = 1, maxZ = 1;
		if (shapes.length > 0) {
			minX = minY = minZ = 1;
			maxX = maxY = maxZ = 0;
			for (const shape of shapes) {
				minX = Math.min(minX, shape[0] ?? 0);
				minY = Math.min(minY, shape[1] ?? 0);
				minZ = Math.min(minZ, shape[2] ?? 0);
				maxX = Math.max(maxX, shape[3] ?? 1);
				maxY = Math.max(maxY, shape[4] ?? 1);
				maxZ = Math.max(maxZ, shape[5] ?? 1);
			}
		}
		const centre = new Vec3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);

		// Aim the ray at the middle of the actual shape, not the middle of the block — a ray at
		// the block centre passes straight over a closed trapdoor without touching it.
		const dx = pos.x + centre.x - eye.x;
		const dy = pos.y + centre.y - eye.y;
		const dz = pos.z + centre.z - eye.z;
		const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

		if (length > 0) {

			// The published raycast type doesn't describe what the implementation returns (it
			// hands back the block itself, with `face` and `intersect` attached), so read it
			// structurally rather than trusting the declaration.
			const hit = MinecraftClient.bot.world.raycast(
				new Vec3(eye.x, eye.y, eye.z),
				new Vec3(dx / length, dy / length, dz / length),
				Stasis.INTERACT_REACH + 1
			) as unknown as { position?: Vec3Like; face?: number; intersect?: Vec3Like } | null;

			if (hit?.position && hit.intersect
				&& hit.position.x === pos.x && hit.position.y === pos.y && hit.position.z === pos.z
				&& typeof hit.face === "number" && hit.face >= 0 && hit.face <= 5) {
				const intersect = new Vec3(hit.intersect.x, hit.intersect.y, hit.intersect.z);
				return {
					face: hit.face as FaceIndex,
					hit: intersect,
					cursor: new Vec3(intersect.x - pos.x, intersect.y - pos.y, intersect.z - pos.z)
				};
			}
		}

		// Obstructed, or the ray clipped a neighbour first — fall back to the middle of whichever
		// face of the shape points at the bot. Still on the shape's surface, which is what the
		// reconstruction on the server side cares about.
		const face = faceToward(pos, eye);
		const cursor = centre.clone();
		switch (face) {
			case Face.DOWN:
				cursor.y = minY;
				break;
			case Face.UP:
				cursor.y = maxY;
				break;
			case Face.NORTH:
				cursor.z = minZ;
				break;
			case Face.SOUTH:
				cursor.z = maxZ;
				break;
			case Face.WEST:
				cursor.x = minX;
				break;
			case Face.EAST:
				cursor.x = maxX;
				break;
		}

		return { face, hit: new Vec3(pos.x + cursor.x, pos.y + cursor.y, pos.z + cursor.z), cursor };
	}

	/**
	 * Interact with the stasis by activating the trapdoor block.
	 *
	 * Sends the packets directly rather than going through mineflayer's `activateBlock`, which
	 * depends on the physics loop we replace. Order matters: the rotation has to be on the wire
	 * *before* the interaction, because a 1.20.1 `block_place` carries no rotation of its own and
	 * the server validates reach and line of sight against whatever it last saw us looking at.
	 *
	 * Resolves once the server confirms the block state changed, or false on timeout.
	 * @returns {Promise<boolean>} whether the interaction was successful (i.e. the block state changed)
	 */
	public interact(): Promise<boolean> {
		const pos = this.block.position;
		if (this.state.open === false) return Promise.resolve(true);

		const entity = MinecraftClient.bot.entity;
		const eye = new Vec3(entity.position.x, entity.position.y + EYE_HEIGHT, entity.position.z);
		const { face, hit, cursor } = this.resolveClick(pos, eye);

		// Out of reach — retrying from here would just burn interaction budget against a server
		// that is going to reject every attempt. Let the caller re-path instead.
		const distance = eye.distanceTo(hit);
		if (distance > Stasis.INTERACT_REACH) {
			StasisManager.logger.warn(`Stasis ${ chalk.yellow(this.id) } is ${ chalk.yellow(distance.toFixed(1)) }m from the eye, out of interaction range`);
			return Promise.resolve(false);
		}

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

		// Sneaking suppresses block interaction in favour of placing the held item, so make sure
		// we are not — but only send the transition if the server actually thinks we are, since a
		// redundant one is a duplicate status change.
		if (MinecraftClient.physics.controls.sneak) MinecraftClient.physics.controls.sneak = false;

		// Rotation first, then the interaction it is meant to validate.
		MinecraftClient.rotation.silentLookAt(hit);

		if (!MinecraftClient.interaction.useItemOn(pos, face, cursor)) {
			StasisManager.logger.warn(`Interaction with stasis ${ chalk.yellow(this.id) } was dropped by the rate limiter`);
			return Promise.resolve(false);
		}

		MinecraftClient.interaction.swingArm();

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

	/**
	 * Determines if the stasis has a pearl in it that is within the trigger block's bounding box
	 * @return {boolean} true if a pearl is within the trigger, false otherwise
	 */
	public isArmed(): boolean {
		const shapes: Shape[] = [ [ 0, 0, 0, 1, 1, 1 ] ];
		return this.pearls.some(pearl => {
			const pos = pearl.entity.position;
			const hw = pearl.entity.width / 2;
			const h = pearl.entity.height;
			const pMinX = pos.x - hw;
			const pMinY = pos.y;
			const pMinZ = pos.z - hw;
			const pMaxX = pos.x + hw;
			const pMaxY = pos.y + h;
			const pMaxZ = pos.z + hw;
			return shapes.some((shape: Shape) => {
				const bMinX = this.block.position.x + shape[0];
				const bMinY = this.block.position.y + shape[1];
				const bMinZ = this.block.position.z + shape[2];
				const bMaxX = this.block.position.x + shape[3];
				const bMaxY = this.block.position.y + shape[4];
				const bMaxZ = this.block.position.z + shape[5];
				return pMinX < bMaxX && pMaxX > bMinX
					&& pMinY < bMaxY && pMaxY > bMinY
					&& pMinZ < bMaxZ && pMaxZ > bMinZ;
			});
		});
	}

}