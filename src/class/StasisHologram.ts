import crypto from "crypto";
import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Vec3 } from "vec3";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { Pearl } from "./Pearl";
import { StasisColumn } from "./StasisColumn";

/**
 * Owns the client-side hologram overlay for a single connected proxy player.
 *
 * For each suspended pearl currently in visual range, spawns a fake invisible
 * armor stand at its stasis chamber's water surface displaying the pearl
 * owner's username.
 *
 * Holograms are entirely client-side — they are never sent to 2b2t.
 */
export class StasisHologram {

	/** Counter for fake entity IDs (high range to avoid collisions with real entities) */
	private static nextEntityId = 0x70000000;

	/** Map from pearl entity id → fake armor stand entity id currently spawned on the client */
	private readonly entities = new Map<number, number>();

	/** Per-pearl listeners we attached, kept so we can detach them on disconnect */
	private readonly pearlListeners = new Map<number, { suspended:() => void; destroyed: () => void }>();

	constructor(
		private readonly client: MinecraftClient,
		private readonly bot: Mineflayer
	) {}

	/** Begin tracking pearls and spawn holograms for any currently visible suspended ones */
	public attach() {
		for (const pearl of StasisManager.pearls.values()) this.track(pearl);
		this.bot._client.on("spawn_entity", this.onSpawnEntity);
		this.bot.on("respawn", this.onRespawn);
	}

	/** Tear down all holograms and listeners. The client is assumed to be disconnecting. */
	public detach() {
		this.bot._client.off("spawn_entity", this.onSpawnEntity);
		this.bot.off("respawn", this.onRespawn);
		for (const [ pearlId, listeners ] of this.pearlListeners) {
			const pearl = StasisManager.pearls.get(pearlId);
			pearl?.off("suspended", listeners.suspended);
			pearl?.off("destroyed", listeners.destroyed);
		}
		this.pearlListeners.clear();
		this.entities.clear();
	}

	/**
	 * On dimension change the client wipes all entities, so our tracking maps are
	 * stale. Detach all pearl listeners, clear state, and re-track once chunks load.
	 */
	private readonly onRespawn = () => {
		for (const [ pearlId, listeners ] of this.pearlListeners) {
			const pearl = StasisManager.pearls.get(pearlId);
			pearl?.off("suspended", listeners.suspended);
			pearl?.off("destroyed", listeners.destroyed);
		}
		this.pearlListeners.clear();
		this.entities.clear();
		this.bot.once("chunkColumnLoad", () => {
			for (const pearl of StasisManager.pearls.values()) this.track(pearl);
		});
	};

	/**
	 * When a new pearl entity spawns, StasisManager will create a Pearl shortly
	 * after. Defer briefly to let it register, then start tracking it.
	 */
	private readonly onSpawnEntity = (packet: { entityId: number }) => {
		setImmediate(() => {
			const pearl = StasisManager.pearls.get(packet.entityId);
			if (pearl) this.track(pearl);
		});
	};

	/**
	 * Hook a pearl: spawn a hologram immediately if already suspended, otherwise
	 * wait for the "suspended" event. Always despawn on "destroyed".
	 */
	private track(pearl: Pearl) {
		if (this.pearlListeners.has(pearl.entity.id)) return;

		const onSuspended = () => void this.spawn(pearl);
		const onDestroyed = () => this.despawn(pearl.entity.id);
		this.pearlListeners.set(pearl.entity.id, { suspended: onSuspended, destroyed: onDestroyed });
		pearl.on("suspended", onSuspended);
		pearl.on("destroyed", onDestroyed);

		if (pearl.suspended) void this.spawn(pearl);
	}

	/** Spawn an invisible armor stand with the pearl owner's username at the chamber's water surface */
	private async spawn(pearl: Pearl) {
		if (this.entities.has(pearl.entity.id)) return;

		// Resolve the stasis column the pearl is sitting in, to get surfaceY + canonical X/Z.
		const pos = pearl.entity.position;
		const column = StasisColumn.get(new Vec3(pos.x, pos.y, pos.z));
		if (!column) return; // Chunks not loaded yet

		// If ownerId hasn't arrived yet (metadata still in flight), wait for it.
		// Race against "destroyed" so we don't leak a dangling listener.
		const ownerId = pearl.ownerId ?? await new Promise<string | null>(resolve => {
			const onOwner = (uuid: string) => {
				pearl.off("destroyed", onDestroy);
				resolve(uuid);
			};
			const onDestroy = () => {
				pearl.off("owner", onOwner);
				resolve(null);
			};
			pearl.once("owner", onOwner);
			pearl.once("destroyed", onDestroy);
		});

		// Pearl may have been destroyed while we awaited the owner.
		if (!StasisManager.pearls.has(pearl.entity.id)) return;
		if (this.entities.has(pearl.entity.id)) return;

		// Resolve a friendly username — prefer the in-game player list, fall back to the DB, then UUID.
		const ownerName = ownerId
			? Object.values(this.bot.players).find(p => p.uuid === ownerId)?.username
				?? (await prisma.player.findUnique({ where: { id: ownerId }}).catch(() => null))?.username
				?? ownerId
			: "(unknown)";

		const entityId = StasisHologram.nextEntityId++;
		this.entities.set(pearl.entity.id, entityId);

		const proto = this.client.serializer.proto;

		// Spawn an armor stand centered on the trapdoor's X/Z, at the surface Y level.
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "spawn_entity",
			params: {
				entityId,
				objectUUID: crypto.randomUUID(),
				type: 2, // armor_stand
				x: column.pos2.x + 0.5,
				y: column.surfaceY + 1.5,
				z: column.pos2.z + 0.5,
				pitch: 0,
				yaw: 0,
				headPitch: 0,
				objectData: 0,
				velocity: { x: 0, y: 0, z: 0 }
			}
		}));

		// Make it invisible, give it a name tag, and turn it into a marker (no hitbox / no model).
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_metadata",
			params: {
				entityId,
				metadata: [
					{ key: 0, type: "byte", value: 0x20 }, // entity flags: invisible
					{ key: 2, type: "optional_component", value: JSON.stringify({ text: ownerName, color: "gold" }) }, // custom name
					{ key: 3, type: "boolean", value: true }, // custom name visible
					{ key: 5, type: "boolean", value: true }, // no gravity
					{ key: 15, type: "byte", value: 0x10 } // armor stand flags: marker (no hitbox)
				]
			}
		}));

	}

	/** Despawn the hologram for a given pearl, if one exists */
	private despawn(pearlId: number) {
		const entityId = this.entities.get(pearlId);
		if (entityId === undefined) return;
		this.entities.delete(pearlId);

		const listeners = this.pearlListeners.get(pearlId);
		if (listeners) {
			const pearl = StasisManager.pearls.get(pearlId);
			pearl?.off("suspended", listeners.suspended);
			pearl?.off("destroyed", listeners.destroyed);
			this.pearlListeners.delete(pearlId);
		}

		const proto = this.client.serializer.proto;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_destroy",
			params: { entityIds: [ entityId ]}
		}));
	}

}
