import crypto from "crypto";
import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { Pearl } from "./Pearl";
import { StasisColumn } from "./StasisColumn";

type SkinProperty = { name: string; value: string; signature?: string };

/** Minimal shape of the Proxy playerList entries we need for skin lookup */
interface PlayerListLike {
	properties: SkinProperty[];
}

/**
 * Owns the client-side hologram overlay for a single connected proxy player.
 *
 * For each suspended pearl currently in visual range, spawns a fake player
 * entity at its stasis chamber's water surface showing the pearl owner's skin
 * and username.
 *
 * Holograms are entirely client-side — they are never sent to 2b2t.
 */
export class StasisHologram {

	/** Counter for fake entity IDs (high range to avoid collisions with real entities) */
	private static nextEntityId = 0x70000000;

	/** Map from pearl entity id → { fake entity id, fake UUID, nametag entity id } currently spawned on the client */
	private readonly entities = new Map<number, { entityId: number; fakeUUID: string; fakeName: string; ownerName: string; nametagEntityIds: number[] }>();

	/** Per-pearl listeners we attached, kept so we can detach them on disconnect */
	private readonly pearlListeners = new Map<number, { suspended:() => void; destroyed: () => void }>();

	/** Skin properties cache: owner UUID → properties array */
	private readonly skinCache = new Map<string, SkinProperty[]>();

	/** Scoreboard team name used to hide nametags on all fake player entities */
	private static readonly HIDDEN_NAMETAG_TEAM = "__stasis_holo__";

	/** Fake window ID used for hologram container UI (chosen high to avoid conflicts with server-assigned IDs) */
	private static readonly WINDOW_ID = 200;

	/** Window ID currently open on this client, or null if none */
	private openWindowId: number | null = null;

	/** Last known proxy-client position, extracted from C→S position packets */
	private clientPos: { x: number; y: number; z: number } | null = null;

	constructor(
		private readonly client: MinecraftClient,
		private readonly bot: Mineflayer,
		private readonly playerList?: Map<string, PlayerListLike>
	) {}

	/** Begin tracking pearls and spawn holograms for any currently visible suspended ones */
	public attach() {
		this.createHiddenNametagTeam();
		for (const pearl of StasisManager.pearls.values()) this.track(pearl);
		this.bot._client.on("spawn_entity", this.onSpawnEntity);

		// Track the proxy-client's position via their C→S movement packets.
		// We cannot use bot.on("move") because PhysicsManager pauses bot physics
		// while a client is connected, so bot.entity.position never updates.
		(this.client as unknown as NodeJS.EventEmitter).on("packet", this.onClientPositionPacket);
		this.bot.on("respawn", this.onRespawn);
	}

	/** Tear down all holograms and listeners. The client is assumed to be disconnecting. */
	public detach() {
		this.bot._client.off("spawn_entity", this.onSpawnEntity);
		(this.client as unknown as NodeJS.EventEmitter).off("packet", this.onClientPositionPacket);
		this.bot.off("respawn", this.onRespawn);
		for (const [ pearlId, listeners ] of this.pearlListeners) {
			const pearl = StasisManager.pearls.get(pearlId);
			pearl?.off("suspended", listeners.suspended);
			pearl?.off("destroyed", listeners.destroyed);
		}
		this.pearlListeners.clear();
		this.entities.clear();
		this.removeHiddenNametagTeam();
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
		this.clientPos = null;
		this.bot.once("chunkColumnLoad", () => {
			this.createHiddenNametagTeam();
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
	 * Sends entity_look + entity_head_rotation to orient a single fake entity
	 * toward the bot's current position. No-ops if the bot position is unknown.
	 */
	private sendRotation(entityId: number, holoX: number, holoY: number, holoZ: number) {
		const pos = this.clientPos ?? this.bot.entity?.position;
		if (!pos) return;

		const dx = pos.x - holoX;
		const dy = (pos.y + 1.62) - holoY;
		const dz = pos.z - holoZ;

		const yawRad = Math.atan2(-dx, dz);
		const pitchRad = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));

		// Protocol encodes angles as a signed byte (-128..127): 256 steps per full rotation
		const yawByte = (Math.floor(yawRad / (2 * Math.PI) * 256) << 24) >> 24;
		const pitchByte = (Math.floor(pitchRad / (2 * Math.PI) * 256) << 24) >> 24;

		const proto = this.client.serializer.proto;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_look",
			params: { entityId, yaw: yawByte, pitch: pitchByte, onGround: false }
		}));
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_head_rotation",
			params: { entityId, headYaw: yawByte }
		}));
	}

	/**
	 * Fires for every packet the proxy-client sends. Extracts the player's
	 * X/Y/Z from `position` and `position_look` packets, then rotates all fake
	 * player entities to face them. Throttled to 0.5-block movements.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol packet shape
	private readonly onClientPositionPacket = (data: any, meta: { name: string }) => {
		if (meta.name !== "position" && meta.name !== "position_look") return;
		if (typeof data.x !== "number" || typeof data.y !== "number" || typeof data.z !== "number") return;

		if (this.clientPos) {
			const dx = data.x - this.clientPos.x;
			const dy = data.y - this.clientPos.y;
			const dz = data.z - this.clientPos.z;
			if (dx * dx + dy * dy + dz * dz < 0.25) return; // < 0.5 blocks
		}
		this.clientPos = { x: data.x, y: data.y, z: data.z };

		if (this.entities.size === 0) return;

		for (const [ pearlId, entry ] of this.entities) {
			const pearl = StasisManager.pearls.get(pearlId);
			if (!pearl?.entity?.position) continue;

			const column = StasisColumn.get(new Vec3(pearl.entity.position.x, pearl.entity.position.y, pearl.entity.position.z));
			if (!column) continue;

			try {
				this.sendRotation(
					entry.entityId,
					column.pos2.x + 0.5,
					column.surfaceY + 19 / 16 + 1.62, // fake player feet (surface + 19/16) + eye height
					column.pos2.z + 0.5
				);
			} catch { /* client may be mid-disconnect */ }
		}
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

	/** Spawn a fake player entity with the pearl owner's skin at the chamber's water surface */
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
				?? (await prisma.player.findUnique({ where: { server_player: { uuid: ownerId, server: Client.host }}}).catch(() => null))?.username
				?? ownerId
			: "(unknown)";

		// Resolve skin properties for the owner.
		const skinProperties = ownerId ? await this.fetchSkinProperties(ownerId) : [];

		const entityId = StasisHologram.nextEntityId++;

		// Use a random UUID so the fake player never collides with the real owner's UUID
		// in the existing tab list (e.g. if they're already on 2b2t).
		const fakeUUID = crypto.randomUUID();

		// Derive a unique fake username from the UUID so team membership never touches real players.
		const fakeName = fakeUUID.replace(/-/g, "").substring(0, 16);
		this.entities.set(pearl.entity.id, { entityId, fakeUUID, fakeName, ownerName, nametagEntityIds: []});

		const proto = this.client.serializer.proto;

		// Register the fake player in the client's player list so the skin is resolved.
		// update_listed + listed:false keeps them out of the tab list UI while preserving
		// the skin texture cache (player_remove would drop the cache immediately).
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "player_info",
			params: {
				action: {
					add_player: true,
					initialize_chat: false,
					update_game_mode: false,
					update_listed: true,
					update_latency: false,
					update_display_name: false
				},
				data: [ {
					uuid: fakeUUID,
					player: { name: fakeName, properties: skinProperties },
					listed: false
				} ]
			}
		}));

		// Spawn the fake player entity centered on the trapdoor's X/Z, at the surface Y level.
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "named_entity_spawn",
			params: {
				entityId,
				playerUUID: fakeUUID,
				x: column.pos2.x + 0.5,
				y: column.surfaceY + 19 / 16,
				z: column.pos2.z + 0.5,
				yaw: 0,
				pitch: 0
			}
		}));

		// Enable all skin layers: hat, jacket, left/right sleeves, left/right pants legs (0x7f).
		// Metadata index 17 is the "displayed skin parts" byte for player entities.
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_metadata",
			params: {
				entityId,
				metadata: [
					{ key: 17, type: "byte", value: 0x7f }
				]
			}
		}));

		// Add the fake player to the hidden-nametag team so the username label is invisible.
		// We use fakeName (not ownerName) so real players with the same username are unaffected.
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "teams",
			params: {
				team: StasisHologram.HIDDEN_NAMETAG_TEAM,
				mode: 3, // add players
				players: [ fakeName ]
			}
		}));

		// Spawn an invisible marker armor stand floating above the fake player's head
		// to act as the visible nametag hologram.
		const nametagY = column.surfaceY + 3; // ~ above player's head
		
		const lines = [
			{ text: ownerName, color: "white", bold: true },
			{ text: "Suspended in Stasis", color: "gray" }
		];

		lines.reverse();
		
		const nametagEntityIds = this.entities.get(pearl.entity.id)!.nametagEntityIds;

		for (let i = 0; i < lines.length; i++) {
			const lineEntityId = StasisHologram.nextEntityId++;
			nametagEntityIds.push(lineEntityId);

			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "spawn_entity",
				params: {
					entityId: lineEntityId,
					objectUUID: crypto.randomUUID(),
					type: 2, // armor_stand
					x: column.pos2.x + 0.5,
					y: nametagY + i * 0.25, // stack lines vertically with 0.25 blocks between
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
					entityId: lineEntityId,
					metadata: [
						{ key: 0, type: "byte", value: 0x20 }, // entity flags: invisible
						{ key: 2, type: "optional_component", value: JSON.stringify(lines[i]) }, // custom name
						{ key: 3, type: "boolean", value: true }, // custom name visible
						{ key: 5, type: "boolean", value: true }, // no gravity
						{ key: 15, type: "byte", value: 0x10 } // armor stand flags: marker (no hitbox)
					]
				}
			}));
		}

		// Immediately orient the hologram toward the bot without waiting for the next move event.
		try {
			this.sendRotation(
				entityId,
				column.pos2.x + 0.5,
				column.surfaceY + 19 / 16 + 1.62, // fake player feet (surface + 19/16) + eye height
				column.pos2.z + 0.5
			);
		} catch { /* bot position may not be available yet */ }

	}

	/** Despawn the hologram for a given pearl, if one exists */
	private despawn(pearlId: number) {
		const entry = this.entities.get(pearlId);
		if (entry === undefined) return;
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
			params: { entityIds: [ entry.entityId, ...entry.nametagEntityIds ]}
		}));

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "player_remove",
			params: { players: [ entry.fakeUUID ]}
		}));

		// Remove the fake player name from the hidden-nametag team
		if (entry.fakeName) {
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "teams",
				params: {
					team: StasisHologram.HIDDEN_NAMETAG_TEAM,
					mode: 4, // remove players
					players: [ entry.fakeName ]
				}
			}));
		}
	}

	/**
	 * Send a teams create packet to the client with nameTagVisibility: "never".
	 * This is purely client-side — it never reaches 2b2t.
	 */
	private createHiddenNametagTeam() {
		const proto = this.client.serializer.proto;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "teams",
			params: {
				team: StasisHologram.HIDDEN_NAMETAG_TEAM,
				mode: 0, // create team
				name: JSON.stringify({ text: "" }),
				friendlyFire: 0,
				nameTagVisibility: "never",
				collisionRule: "never",
				formatting: 21, // RESET
				prefix: JSON.stringify({ text: "" }),
				suffix: JSON.stringify({ text: "" }),
				players: []
			}
		}));
	}

	/** Remove the hidden-nametag team from the client. */
	private removeHiddenNametagTeam() {
		try {
			const proto = this.client.serializer.proto;
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "teams",
				params: {
					team: StasisHologram.HIDDEN_NAMETAG_TEAM,
					mode: 1 // remove team
				}
			}));
		} catch { /* client may already be disconnected */ }
	}

	/**
	 * Fetch skin properties for a player UUID.
	 * Checks the local skin cache, then the Proxy's playerList (for online players),
	 * then falls back to Mojang's session server API.
	 */
	private async fetchSkinProperties(uuid: string): Promise<SkinProperty[]> {
		const cached = this.skinCache.get(uuid);
		if (cached) return cached;

		// Prefer already-cached data from the Proxy's live tab list (no network call needed)
		const fromList = this.playerList?.get(uuid)?.properties;
		if (fromList?.length) {
			this.skinCache.set(uuid, fromList);
			return fromList;
		}

		try {
			const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${ uuid.replace(/-/g, "") }?unsigned=false`);
			if (res.ok) {
				const data = await res.json() as { properties?: SkinProperty[] };
				const props = data.properties ?? [];
				this.skinCache.set(uuid, props);
				return props;
			}
		} catch { /* network error — proceed without skin */ }

		return [];
	}

	/**
	 * Called by the proxy when the client sends a use_entity packet.
	 * Returns true if the packet was consumed (entity is one of our fake holograms).
	 */
	public handleInteract(data: { target: number }): boolean {
		for (const [ , entry ] of this.entities) {
			if (entry.entityId === data.target) {
				this.openContainer(entry);
				return true;
			}
		}
		return false;
	}

	/**
	 * Called by the proxy when the client sends a close_window packet.
	 * Returns true if the packet was consumed (it was closing our fake container).
	 */
	public handleCloseWindow(data: { windowId: number }): boolean {
		if (data.windowId !== StasisHologram.WINDOW_ID || this.openWindowId === null) return false;
		this.openWindowId = null;
		return true;
	}

	/** Open a client-side 9×3 chest container for the given hologram entry. */
	private openContainer(entry: { ownerName: string }) {
		const proto = this.client.serializer.proto;
		const windowId = StasisHologram.WINDOW_ID;
		this.openWindowId = windowId;

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "open_window",
			params: {
				windowId,
				inventoryType: 2, // generic_9x3
				windowTitle: JSON.stringify({ text: entry.ownerName, color: "white", bold: true })
			}
		}));

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "window_items",
			params: {
				windowId,
				stateId: 0,
				items: Array(27).fill({ present: false }),
				carriedItem: { present: false }
			}
		}));
	}

}
