import crypto from "crypto";
import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Vec3 } from "vec3";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { Pearl } from "~/client/minecraft/Pearl";
import { StasisColumn } from "~/client/minecraft/StasisColumn";
import { prisma } from "~/prisma";

type SkinProperty = { name: string; value: string; signature?: string };

export interface PlayerListLike {
	properties: SkinProperty[];
}

interface SpawnVisualParams {
	entityId: number;
	fakeUUID: string;
	fakeName: string;
	skinProperties: SkinProperty[];
	column: StasisColumn;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw minecraft-protocol proto object
	proto: any;
}

interface SpawnVisualResult {
	nametagY: number;
	eyeY: number;
}

type EntityEntry = {
	entityId: number;
	fakeUUID: string;
	fakeName: string;
	ownerName: string;
	nametagEntityIds: number[];
	eyeY: number;
};

export const VALID_RENDERERS = [ "head", "body", "text", "off" ] as const;
export type HologramRenderer = (typeof VALID_RENDERERS)[number];

const envRaw = (process.env.HOLOGRAM_RENDERER ?? "body").toLowerCase();
const DEFAULT_RENDERER: HologramRenderer = (VALID_RENDERERS as readonly string[]).includes(envRaw)
	? (envRaw as HologramRenderer)
	: "body";

// ─────────────────────────────────────────────────────────────────────────────
// Base hologram class
// ─────────────────────────────────────────────────────────────────────────────

abstract class BaseHologram {

	protected static nextEntityId = 0x70000000;

	private readonly entities = new Map<number, EntityEntry>();
	private readonly pearlListeners = new Map<number, { suspended:() => void; destroyed: () => void }>();
	private readonly skinCache = new Map<string, SkinProperty[]>();

	protected static readonly HIDDEN_NAMETAG_TEAM = "__stasis_holo__";

	private clientPos: { x: number; y: number; z: number } | null = null;

	public onTracked?: (pearlId: number) => void;

	constructor(
		protected readonly client: MinecraftClient,
		protected readonly bot: Mineflayer,
		protected readonly playerList?: Map<string, PlayerListLike>
	) {}

	public isTracking(pearlId: number): boolean {
		return this.entities.has(pearlId);
	}

	public getPearlIdByEntity(entityId: number): number | null {
		for (const [ pearlId, entry ] of this.entities) {
			if (entry.entityId === entityId) return pearlId;
			if (entry.nametagEntityIds.includes(entityId)) return pearlId;
		}
		return null;
	}

	protected abstract spawnVisual(params: SpawnVisualParams): SpawnVisualResult;

	// ─────────────────────────────── lifecycle ───────────────────────────────

	public attach() {
		this.createHiddenNametagTeam();
		for (const pearl of StasisManager.pearls.values()) this.track(pearl);
		this.bot._client.on("spawn_entity", this.onSpawnEntity);
		(this.client as unknown as NodeJS.EventEmitter).on("packet", this.onClientPositionPacket);
		this.bot.on("respawn", this.onRespawn);
	}

	public detach() {
		this.bot._client.off("spawn_entity", this.onSpawnEntity);
		(this.client as unknown as NodeJS.EventEmitter).off("packet", this.onClientPositionPacket);
		this.bot.off("respawn", this.onRespawn);

		for (const pearlId of Array.from(this.entities.keys())) {
			try {
				this.despawn(pearlId);
			} catch { /* client may have disconnected */ }
		}

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
			if (dx * dx + dy * dy + dz * dz < 0.25) return;
		}
		this.clientPos = { x: data.x, y: data.y, z: data.z };
		if (this.entities.size === 0) return;

		for (const [ pearlId, entry ] of this.entities) {
			const pearl = StasisManager.pearls.get(pearlId);
			if (!pearl?.entity?.position) continue;
			const column = StasisColumn.get(new Vec3(pearl.entity.position.x, pearl.entity.position.y, pearl.entity.position.z));
			if (!column) continue;
			try {
				this.sendRotation(entry.entityId, column.pos2.x + 0.5, entry.eyeY, column.pos2.z + 0.5);
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

		if (!StasisManager.pearls.has(pearl.entity.id)) return;
		if (this.entities.has(pearl.entity.id)) return;

		const ownerName = ownerId
			? Object.values(this.bot.players).find(p => p.uuid === ownerId)?.username
				?? (await prisma.player.findUnique({ where: { id: ownerId }}).catch(() => null))?.username
				?? ownerId
			: "(unknown)";

		const skinProperties = ownerId ? await this.fetchSkinProperties(ownerId) : [];
		const entityId = BaseHologram.nextEntityId++;
		const fakeUUID = crypto.randomUUID();
		const fakeName = fakeUUID.replace(/-/g, "").substring(0, 16);

		this.entities.set(pearl.entity.id, { entityId, fakeUUID, fakeName, ownerName, nametagEntityIds: [], eyeY: 0 });

		const proto = this.client.serializer.proto;

		const { nametagY, eyeY } = this.spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto });
		const entry = this.entities.get(pearl.entity.id)!;
		entry.eyeY = eyeY;

		// All skin layers visible
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_metadata",
			params: { entityId, metadata: [ { key: 17, type: "byte", value: 0x7f } ]}
		}));

		// Hide built-in nametag via team
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "teams",
			params: { team: BaseHologram.HIDDEN_NAMETAG_TEAM, mode: 3, players: [ fakeName ]}
		}));

		// Floating armor-stand nametag lines
		const lines = [
			{ text: ownerName, color: "white", bold: true },
			{ text: "Suspended in Stasis", color: "gray" }
		];
		lines.reverse();

		const nametagEntityIds = this.entities.get(pearl.entity.id)!.nametagEntityIds;

		for (let i = 0; i < lines.length; i++) {
			const lineEntityId = BaseHologram.nextEntityId++;
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
						{ key: 0, type: "byte", value: 0x20 },
						{ key: 2, type: "optional_component", value: JSON.stringify(lines[i]) },
						{ key: 3, type: "boolean", value: true },
						{ key: 5, type: "boolean", value: true },
						{ key: 15, type: "byte", value: 0x10 }
					]
				}
			}));
		}

		try {
			this.sendRotation(entityId, column.pos2.x + 0.5, eyeY, column.pos2.z + 0.5);
		} catch { /* bot position may not be available yet */ }

		try {
			this.onTracked?.(pearl.entity.id);
		} catch { /* listener errors must not break spawn */ }
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
				params: { team: BaseHologram.HIDDEN_NAMETAG_TEAM, mode: 4, players: [ entry.fakeName ]}
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
				team: BaseHologram.HIDDEN_NAMETAG_TEAM,
				mode: 0,
				name: JSON.stringify({ text: "" }),
				friendlyFire: 0,
				nameTagVisibility: "never",
				collisionRule: "never",
				formatting: 21,
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
				params: { team: BaseHologram.HIDDEN_NAMETAG_TEAM, mode: 1 }
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer variants
// ─────────────────────────────────────────────────────────────────────────────

/** Full-opacity standing player above each stasis chamber. */
class BodyHologram extends BaseHologram {
	protected override spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto }: SpawnVisualParams): SpawnVisualResult {
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "player_info",
			params: {
				action: {
					add_player: true, initialize_chat: false,
					update_game_mode: false, update_listed: true,
					update_latency: false, update_display_name: false
				},
				data: [ { uuid: fakeUUID, player: { name: fakeName, properties: skinProperties }, listed: false } ]
			}
		}));

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "named_entity_spawn",
			params: { entityId, playerUUID: fakeUUID, x: column.pos2.x + 0.5, y: column.surfaceY + 19 / 16, z: column.pos2.z + 0.5, yaw: 0, pitch: 0 }
		}));

		return { nametagY: column.surfaceY + 3, eyeY: column.surfaceY + 19 / 16 + 1.62 };
	}
}

/** Semi-transparent spectator-mode ghost head. */
class HeadHologram extends BaseHologram {
	protected override spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto }: SpawnVisualParams): SpawnVisualResult {
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "player_info",
			params: {
				action: {
					add_player: true, initialize_chat: false,
					update_game_mode: true, update_listed: true,
					update_latency: false, update_display_name: false
				},
				data: [ { uuid: fakeUUID, player: { name: fakeName, properties: skinProperties }, gamemode: 3, listed: false } ]
			}
		}));

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "named_entity_spawn",
			params: { entityId, playerUUID: fakeUUID, x: column.pos2.x + 0.5, y: column.pos2.y + 0.5, z: column.pos2.z + 0.5, yaw: 0, pitch: 0 }
		}));

		return { nametagY: column.pos2.y + 2.5, eyeY: column.pos2.y + 2.12 };
	}
}

/** Floating text labels only — no player entity. */
class TextOnlyHologram extends BaseHologram {
	protected override spawnVisual({ column }: SpawnVisualParams): SpawnVisualResult {
		return { nametagY: column.surfaceY + 1, eyeY: column.surfaceY + 1 };
	}
}

/** No-op renderer — pearls shown as-is with no decoration. */
class OffHologram extends BaseHologram {
	protected override spawnVisual(_params: SpawnVisualParams): SpawnVisualResult {
		return { nametagY: 0, eyeY: 0 };
	}
	public override attach(): void { /* intentionally empty */ }
	public override detach(): void { /* intentionally empty */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type TextHologram = BaseHologram;

export function createHologram(
	client: MinecraftClient,
	bot: Mineflayer,
	playerList?: Map<string, PlayerListLike>,
	override?: HologramRenderer,
	onTracked?: (pearlId: number) => void
): TextHologram {
	const renderer = override ?? DEFAULT_RENDERER;
	let hologram: BaseHologram;
	switch (renderer) {
		case "body": hologram = new BodyHologram(client, bot, playerList); break;
		case "text": hologram = new TextOnlyHologram(client, bot, playerList); break;
		case "off": hologram = new OffHologram(client, bot, playerList); break;
		case "head":
		default: hologram = new HeadHologram(client, bot, playerList);
	}
	hologram.onTracked = onTracked;
	return hologram;
}
