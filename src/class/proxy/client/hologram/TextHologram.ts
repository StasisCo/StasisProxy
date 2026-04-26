import crypto from "crypto";
import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";
import { Pearl } from "../../../Pearl";
import { StasisColumn } from "../../../StasisColumn";

export type SkinProperty = { name: string; value: string; signature?: string };

export interface PlayerListLike {
	properties: SkinProperty[];
}

/** Parameters passed to {@link TextHologram.spawnVisual} for each pearl. */
export interface SpawnVisualParams {
	entityId: number;
	fakeUUID: string;
	fakeName: string;
	skinProperties: SkinProperty[];
	column: StasisColumn;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw minecraft-protocol proto object
	proto: any;
}

type EntityEntry = {
	entityId: number;
	fakeUUID: string;
	fakeName: string;
	ownerName: string;
	nametagEntityIds: number[];
};

/**
 * Abstract base class for stasis chamber hologram renderers.
 *
 * Owns all pearl tracking, nametag armor-stand spawning, rotation, team
 * management, and container interaction. Subclasses implement `spawnVisual()`
 * to register the fake player in the tab list and spawn the visual entity.
 *
 * Usage: `attach()` when a proxy client connects, `detach()` on disconnect.
 */
export abstract class TextHologram {

	/** Shared fake entity ID counter (high range to avoid real entity collisions). */
	protected static nextEntityId = 0x70000000;

	private readonly entities = new Map<number, EntityEntry>();
	private readonly pearlListeners = new Map<number, { suspended:() => void; destroyed: () => void }>();
	private readonly skinCache = new Map<string, SkinProperty[]>();

	protected static readonly HIDDEN_NAMETAG_TEAM = "__stasis_holo__";
	private static readonly WINDOW_ID = 200;

	private openWindowId: number | null = null;
	private clientPos: { x: number; y: number; z: number } | null = null;

	constructor(
		protected readonly client: MinecraftClient,
		protected readonly bot: Mineflayer,
		protected readonly playerList?: Map<string, PlayerListLike>
	) {}

	/**
	 * Register the fake player in the tab list and spawn the visual entity at
	 * the chamber location. Called after all shared setup is done.
	 *
	 * @returns The Y level at which floating nametag armor stands should appear.
	 */
	protected abstract spawnVisual(params: SpawnVisualParams): number;

	// ─────────────────────────────── lifecycle ───────────────────────────────

	/** Begin tracking pearls and spawn holograms for any currently suspended ones. */
	public attach() {
		this.createHiddenNametagTeam();
		for (const pearl of StasisManager.pearls.values()) this.track(pearl);
		this.bot._client.on("spawn_entity", this.onSpawnEntity);
		(this.client as unknown as NodeJS.EventEmitter).on("packet", this.onClientPositionPacket);
		this.bot.on("respawn", this.onRespawn);
	}

	/** Tear down all holograms and listeners. */
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

	// ─────────────────────────────── event handlers ──────────────────────────

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

	private readonly onSpawnEntity = (packet: { entityId: number }) => {
		setImmediate(() => {
			const pearl = StasisManager.pearls.get(packet.entityId);
			if (pearl) this.track(pearl);
		});
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol packet
	private readonly onClientPositionPacket = (data: any, meta: { name: string }) => {
		if (meta.name !== "position" && meta.name !== "position_look") return;
		if (typeof data.x !== "number" || typeof data.y !== "number" || typeof data.z !== "number") return;

		if (this.clientPos) {
			const dx = data.x - this.clientPos.x;
			const dy = data.y - this.clientPos.y;
			const dz = data.z - this.clientPos.z;
			if (dx * dx + dy * dy + dz * dz < 0.25) return; // throttle < 0.5 blocks
		}
		this.clientPos = { x: data.x, y: data.y, z: data.z };
		if (this.entities.size === 0) return;

		for (const [ pearlId, entry ] of this.entities) {
			const pearl = StasisManager.pearls.get(pearlId);
			if (!pearl?.entity?.position) continue;
			const column = StasisColumn.get(new Vec3(pearl.entity.position.x, pearl.entity.position.y, pearl.entity.position.z));
			if (!column) continue;
			try {
				this.sendRotation(entry.entityId, column.pos2.x + 0.5, column.surfaceY + 19 / 16 + 1.62, column.pos2.z + 0.5);
			} catch { /* client may be mid-disconnect */ }
		}
	};

	// ─────────────────────────────── pearl tracking ──────────────────────────

	private track(pearl: Pearl) {
		if (this.pearlListeners.has(pearl.entity.id)) return;
		const onSuspended = () => void this.spawn(pearl);
		const onDestroyed = () => this.despawn(pearl.entity.id);
		this.pearlListeners.set(pearl.entity.id, { suspended: onSuspended, destroyed: onDestroyed });
		pearl.on("suspended", onSuspended);
		pearl.on("destroyed", onDestroyed);
		if (pearl.suspended) void this.spawn(pearl);
	}

	private async spawn(pearl: Pearl) {
		if (this.entities.has(pearl.entity.id)) return;

		const pos = pearl.entity.position;
		const column = StasisColumn.get(new Vec3(pos.x, pos.y, pos.z));
		if (!column) return;

		const ownerId = pearl.ownerId ?? await new Promise<string | null>(resolve => {
			const onOwner = (uuid: string) => {
				pearl.off("destroyed", onDestroy); resolve(uuid);
			};
			const onDestroy = () => {
				pearl.off("owner", onOwner); resolve(null);
			};
			pearl.once("owner", onOwner);
			pearl.once("destroyed", onDestroy);
		});

		if (!StasisManager.pearls.has(pearl.entity.id)) return;
		if (this.entities.has(pearl.entity.id)) return;

		const ownerName = ownerId
			? Object.values(this.bot.players).find(p => p.uuid === ownerId)?.username
				?? (await prisma.player.findUnique({ where: { server_player: { uuid: ownerId, server: Client.host }}}).catch(() => null))?.username
				?? ownerId
			: "(unknown)";

		const skinProperties = ownerId ? await this.fetchSkinProperties(ownerId) : [];
		const entityId = TextHologram.nextEntityId++;
		const fakeUUID = crypto.randomUUID();
		const fakeName = fakeUUID.replace(/-/g, "").substring(0, 16);

		this.entities.set(pearl.entity.id, { entityId, fakeUUID, fakeName, ownerName, nametagEntityIds: []});

		const proto = this.client.serializer.proto;

		// Delegate entity registration + visual spawning to the subclass.
		// Returns the Y level where the nametag lines should float.
		const nametagY = this.spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto });

		// All skin layers (hat, jacket, sleeves, pants legs): 0x7f — same for both renderers.
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_metadata",
			params: { entityId, metadata: [ { key: 17, type: "byte", value: 0x7f } ]}
		}));

		// Hide the built-in nametag via a scoreboard team with nameTagVisibility: "never".
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "teams",
			params: { team: TextHologram.HIDDEN_NAMETAG_TEAM, mode: 3, players: [ fakeName ]}
		}));

		// Spawn floating armor-stand nametag lines above the entity.
		const lines = [
			{ text: ownerName, color: "white", bold: true },
			{ text: "Suspended in Stasis", color: "gray" }
		];
		lines.reverse(); // draw bottom line first so indices are lowest→highest Y

		const nametagEntityIds = this.entities.get(pearl.entity.id)!.nametagEntityIds;

		for (let i = 0; i < lines.length; i++) {
			const lineEntityId = TextHologram.nextEntityId++;
			nametagEntityIds.push(lineEntityId);

			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "spawn_entity",
				params: {
					entityId: lineEntityId,
					objectUUID: crypto.randomUUID(),
					type: 2, // armor_stand
					x: column.pos2.x + 0.5,
					y: nametagY + i * 0.25,
					z: column.pos2.z + 0.5,
					pitch: 0, yaw: 0, headPitch: 0, objectData: 0,
					velocity: { x: 0, y: 0, z: 0 }
				}
			}));

			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "entity_metadata",
				params: {
					entityId: lineEntityId,
					metadata: [
						{ key: 0, type: "byte", value: 0x20 }, // invisible
						{ key: 2, type: "optional_component", value: JSON.stringify(lines[i]) }, // custom name
						{ key: 3, type: "boolean", value: true }, // name visible
						{ key: 5, type: "boolean", value: true }, // no gravity
						{ key: 15, type: "byte", value: 0x10 } // marker (no hitbox)
					]
				}
			}));
		}

		try {
			this.sendRotation(entityId, column.pos2.x + 0.5, column.surfaceY + 19 / 16 + 1.62, column.pos2.z + 0.5);
		} catch { /* bot position may not be available yet */ }
	}

	private despawn(pearlId: number) {
		const entry = this.entities.get(pearlId);
		if (!entry) return;
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
		if (entry.fakeName) {
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "teams",
				params: { team: TextHologram.HIDDEN_NAMETAG_TEAM, mode: 4, players: [ entry.fakeName ]}
			}));
		}
	}

	// ──────────────────────────── rotation helper ────────────────────────────

	private sendRotation(entityId: number, holoX: number, holoY: number, holoZ: number) {
		const pos = this.clientPos ?? this.bot.entity?.position;
		if (!pos) return;

		const dx = pos.x - holoX;
		const dy = (pos.y + 1.62) - holoY;
		const dz = pos.z - holoZ;

		const yawRad = Math.atan2(-dx, dz);
		const pitchRad = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));

		// Protocol encodes angles as a signed byte: 256 steps per full rotation.
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

	// ──────────────────────────── team management ────────────────────────────

	private createHiddenNametagTeam() {
		const proto = this.client.serializer.proto;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "teams",
			params: {
				team: TextHologram.HIDDEN_NAMETAG_TEAM,
				mode: 0, // create
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

	private removeHiddenNametagTeam() {
		try {
			const proto = this.client.serializer.proto;
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "teams",
				params: { team: TextHologram.HIDDEN_NAMETAG_TEAM, mode: 1 } // remove
			}));
		} catch { /* client may already be disconnected */ }
	}

	// ──────────────────────────── skin fetch ─────────────────────────────────

	private async fetchSkinProperties(uuid: string): Promise<SkinProperty[]> {
		const cached = this.skinCache.get(uuid);
		if (cached) return cached;

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
		} catch { /* network error — continue without skin */ }

		return [];
	}

	// ──────────────────────────── container interaction ──────────────────────

	/**
	 * Call when the client sends `use_entity`. Returns `true` if consumed
	 * (the target is one of our fake hologram entities).
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
	 * Call when the client sends `close_window`. Returns `true` if consumed
	 * (it was closing our fake container).
	 */
	public handleCloseWindow(data: { windowId: number }): boolean {
		if (data.windowId !== TextHologram.WINDOW_ID || this.openWindowId === null) return false;
		this.openWindowId = null;
		return true;
	}

	private openContainer(entry: { ownerName: string }) {
		const proto = this.client.serializer.proto;
		const windowId = TextHologram.WINDOW_ID;
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
