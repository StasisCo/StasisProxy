import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, type SpawnVisualParams, TextHologram } from "../TextHologram";

/**
 * Renders a semi-transparent (spectator-mode) ghost player head above each stasis chamber.
 *
 * The entity is spawned in gamemode 3 (spectator) so it appears at ~50% opacity.
 * Entity feet are placed at pos2.y (trapdoor level) so the head and eyes sit at
 * the natural standing eye height of a player at the chamber floor.
 */
export class HeadHologram extends TextHologram {

	constructor(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>) {
		super(client, bot, playerList);
	}

	/**
	 * Register in player_info with spectator gamemode (50% opacity ghost).
	 * Entity feet placed at pos2.y (trapdoor level) so eyes align with a
	 * standing player's eye height at the chamber floor.
	 *
	 * @returns The Y level at which nametag armor stands should be placed.
	 */
	protected override spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto }: SpawnVisualParams): number {
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
				y: column.pos2.y, // feet at trapdoor level — eyes at pos2.y + 1.62 (natural standing eye height)
				z: column.pos2.z + 0.5,
				yaw: 0,
				pitch: 0
			}
		}));

		return column.pos2.y + 2; // nametag Y: above player's head
	}
}
