import crypto from "crypto";
import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, type SpawnVisualParams, type SpawnVisualResult, TextHologram } from "../TextHologram";

/**
 * Renders a semi-transparent (spectator-mode) ghost player head above each stasis chamber.
 *
 * The entity is spawned in gamemode 3 (spectator) so it appears at ~50% opacity.
 * Spectator entities are non-collidable, so we additionally spawn an invisible
 * armor stand at the same position to catch right-click interactions. The
 * armor stand is registered as an interact entity for this hologram.
 *
 * Entity feet are placed at pos2.y (trapdoor level) so the head and eyes sit at
 * the natural standing eye height of a player at the chamber floor.
 */
export class HeadHologram extends TextHologram {

	constructor(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>) {
		super(client, bot, playerList);
	}

	protected override spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto }: SpawnVisualParams): SpawnVisualResult {
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "player_info",
			params: {
				action: {
					add_player: true,
					initialize_chat: false,
					update_game_mode: true,
					update_listed: true,
					update_latency: false,
					update_display_name: false
				},
				data: [ {
					uuid: fakeUUID,
					player: { name: fakeName, properties: skinProperties },
					gamemode: 3, // spectator — renders the entity at 50% opacity
					listed: false
				} ]
			}
		}));

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "named_entity_spawn",
			params: {
				entityId,
				playerUUID: fakeUUID,
				x: column.pos2.x + 0.5,
				y: column.pos2.y + 0.5, // feet at trapdoor level — eyes at pos2.y + 1.62 (natural standing eye height)
				z: column.pos2.z + 0.5,
				yaw: 0,
				pitch: 0
			}
		}));

		// Spawn an invisible armor stand at the same position to catch
		// right-clicks (spectator-mode players are non-collidable).
		// Standard armor stand hitbox is ~0.5×2.0 — covers the head height.
		const interactEntityId = TextHologram.nextEntityId++;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "spawn_entity",
			params: {
				entityId: interactEntityId,
				objectUUID: crypto.randomUUID(),
				type: 2, // armor_stand
				x: column.pos2.x + 0.5,
				y: column.pos2.y + 0.5,
				z: column.pos2.z + 0.5,
				pitch: 0, yaw: 0, headPitch: 0, objectData: 0,
				velocity: { x: 0, y: 0, z: 0 }
			}
		}));
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "entity_metadata",
			params: {
				entityId: interactEntityId,
				metadata: [
					{ key: 0, type: "byte", value: 0x20 }, // invisible
					{ key: 5, type: "boolean", value: true } // no gravity
					// NOT a marker — keeps the standard hitbox so right-clicks register.
				]
			}
		}));

		return {
			nametagY: column.pos2.y + 2.5, // above player's head
			eyeY: column.pos2.y + 2.12, // feet at pos2.y + standing eye offset
			interactEntityIds: [ interactEntityId ]
		};
	}
}

