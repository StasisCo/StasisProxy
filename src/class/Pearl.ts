import EventEmitter from "events";
import type { Player } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { redis } from "~/redis";
import { Client } from "../app/Client";

export type OwnedPearl = Pearl & { readonly owner: Player };

export class Pearl extends EventEmitter<{

	/**
     * Emitted when the pearl's velocity changes (e.g. due to gravity or collisions)
     * @param velocity The new velocity of the pearl as a Vec3
     */
	"velocity": [ Vec3 ];

	/**
     * Emitted when the pearl is destroyed
     */
	"destroyed": [];

	/**
	 * Emitted when the pearl enters a suspended state (i.e. is moving at most 1/8 m/s vertically and is not moving horizontally)
	 */
	"suspended": [];

}> {

	private static readonly instances = new Map<number, Pearl>();
    
	private static listening = false;

	private static attach() {
		if (Pearl.listening) return;
		Pearl.listening = true;

		Client.bot._client.on("entity_velocity", packet => {
			const pearl = Pearl.instances.get(packet.entityId);
			if (!pearl) return;

			const velocity = new Vec3(packet.velocity.x / 8000, packet.velocity.y / 8000, packet.velocity.z / 8000);
			pearl.entity.velocity = velocity;

			if (!pearl.didSuspend && pearl.suspended) {
				pearl.didSuspend = true;
				pearl.emit("suspended");
			}

			pearl.emit("velocity", velocity);

		});

		Client.bot.on("entityGone", entity => {
			const pearl = Pearl.instances.get(entity.id);
			if (!pearl) return;
			pearl.emit("destroyed");
			pearl.isDestroyed = true;
			pearl.removeAllListeners();
			Pearl.instances.delete(entity.id);
		});

	}

	public static from(entity: Entity): Pearl | null {
		const pearl = Pearl.instances.get(entity.id);
		if (!pearl) return null;
		return pearl;
	}

	private didSuspend = false;

	private isDestroyed = false;
    
	public readonly entity: Entity;
    
	public owner: Player | null;

	constructor(packet: Packets.Schema["spawn_entity"]) {
		super();

		// Extract owner UUID from objectData (the thrower's entity ID)
		const entity = Client.bot.entities[packet.entityId];
		if (!entity) throw new Error(`Failed to match spawned pearl to an entity (entityId: ${ packet.entityId })`);
		this.entity = entity;

		// Extract velocity from the spawn packet (mineflayer doesn't set it for spawn_entity)
		entity.velocity = new Vec3(packet.velocity.x / 8000, packet.velocity.y / 8000, packet.velocity.z / 8000);

		// Attempt to identify an owner from objectData
		this.owner = Object.values(Client.bot.players).find(player => player.entity && player.entity.id === packet.objectData) ?? null;

		// Register this pearl instance for velocity tracking and cleanup on despawn
		Pearl.attach();
		Pearl.instances.set(entity.id, this);

		// Save owner in redis if known
		if (this.owner) redis.set(`pearl:${ entity.id }:owner`, JSON.stringify(this.owner));

	}

	/**
     * Checks if the pearl is currently still horizontally and
     * moving at most 1/8 m/s vertically (the threshold for being
     * considered suspended in water).
     */
	public get suspended() {
		return this.entity.velocity.x === 0
            && Math.abs(this.entity.velocity.y) <= 1 / 8
            && this.entity.velocity.z === 0;
	}

	/**
     * Checks if the pearl has been destroyed
     */
	public get destroyed() {
		return this.isDestroyed;
	}

	/**
	 * Type guard to check if the pearl has a known owner
	 */
	public isOwned(): this is OwnedPearl {
		return this.owner !== null;
	}

	/**
	 * Resolves the pearl's owner from Redis if not already known.
	 * @returns The pearl as an OwnedPearl if the owner was resolved, or null if it couldn't be found
	 */
	public async resolve(): Promise<OwnedPearl | Pearl> {
		if (this.isOwned()) return this;
		const data = await redis.get(`pearl:${ this.entity.id }:owner`);
		if (!data) return this;
		try {
			const owner = JSON.parse(data) as Player;
			this.owner = Client.bot.players[owner.uuid] || owner;
		} catch {
			return this;
		}
		if (this.isOwned()) return this;
		return this;
	}

	/**
	 * Associate a pearl with a player and save to Redis. 
	 * @param owner The player to associate with the pearl
	*/
	public async associate(owner: Player) {
		this.owner = owner;
		await redis.set(`pearl:${ this.entity.id }:owner`, JSON.stringify(this.owner));
	}

}