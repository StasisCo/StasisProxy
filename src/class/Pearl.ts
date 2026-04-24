import { redis } from "bun";
import EventEmitter from "events";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { StasisManager } from "~/manager/StasisManager";
import { Client } from "./Client";
import { Stasis } from "./Stasis";

export class Pearl extends EventEmitter<{

	/**
     * Emitted when the pearl is destroyed
	 * @param entityId The ID of the pearl entity that was destroyed
     */
	"destroyed": [ number ];

	/**
	 * Emitted when the pearl's owner is resolved (i.e. the owner is identified and associated with the pearl)
	 * @param owner The player who owns the pearl
	 */
	"owner": [ string ];
		
	/**
	 * Emitted when the pearl enters a suspended state (i.e. is moving at most 1/8 m/s vertically and is not moving horizontally)
	 */
	"suspended": [];

	/**
     * Emitted when the pearl's velocity changes (e.g. due to gravity or collisions)
     * @param velocity The new velocity of the pearl as a Vec3
     */
	"velocity": [ Vec3 ];

}> {

	/**
	 * Finds a pearl instance from an entity
	 * @param entity The entity to find the pearl for
	 * @returns A Pearl instance if the entity is a pearl, or null if it is not
	 */
	public static from(entity: Entity) {
		return StasisManager.pearls.get(entity.id) ?? null;
	}

	/** The UUID of the player who owns this pearl, if known */
	public ownerId?: string;

	/** The in-world entity for this pearl */
	public readonly entity: Entity;

	constructor(packet: Packets.Schema["spawn_entity"]) {
		super();

		// Extract owner UUID from objectData (the thrower's entity ID)
		const entity = Client.bot.entities[packet.entityId];
		if (!entity) throw new Error(`Failed to match spawned pearl to an entity (entityId: ${ packet.entityId })`);
		this.entity = entity;

		// Extract velocity from the spawn packet (mineflayer doesn't set it for spawn_entity)
		entity.velocity = new Vec3(packet.velocity.x / 8000, packet.velocity.y / 8000, packet.velocity.z / 8000);

		// Attempt to identify an owner from objectData
		const owner = Object.values(Client.bot.players).find(player => player.entity && player.entity.id === packet.objectData);
		if (owner) {
			this.ownerId = owner.uuid;
			this.emit("owner", this.ownerId);
			redis.set(`pearl:${ packet.entityId }:owner`, this.ownerId);
			return;
		}

		// Check redis for owner if not found in currently loaded players
		redis.get(`pearl:${ packet.entityId }:owner`).then(data => {

			// If owner data is found in redis, associate it
			if (typeof data === "string") {
				this.ownerId = data;
				this.emit("owner", this.ownerId);
				return;
			}
			
			// If there is an identifiable owner
			if (this.suspended) Stasis.from(this).then(resolved => {
				if (!resolved || !resolved.ownerId) return;
				this.ownerId = resolved.ownerId;
				this.emit("owner", this.ownerId);
				redis.set(`pearl:${ entity.id }:owner`, this.ownerId);
			});

		});

	}

	/**
     * Checks if the pearl is currently still horizontally and
     * moving at most 1/8 m/s vertically (the threshold for being
     * considered suspended in water).
     */
	public get suspended() {
		const { x, y, z } = this.entity.velocity.abs();
		return x === 0
            && y <= 1 / 8
            && z === 0;
	}

}