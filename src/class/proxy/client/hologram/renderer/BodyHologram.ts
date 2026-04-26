import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, type SpawnVisualParams, type SpawnVisualResult, TextHologram } from "../TextHologram";

/**
 * Renders a full-opacity standing player entity above each stasis chamber.
 *
 * The entity is spawned in the default game mode (survival/creative) so it
 * appears fully opaque at the water surface.
 */
export class BodyHologram extends TextHologram {

	constructor(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>) {
		super(client, bot, playerList);
	}

	/**
	 * Register in player_info with no gamemode update (fully opaque appearance).
	 * Entity feet placed at surfaceY + 19/16 (standing in the water block above the trapdoor).
	 *
	 * @returns The Y level at which nametag armor stands should be placed.
	 */
	protected override spawnVisual({ entityId, fakeUUID, fakeName, skinProperties, column, proto }: SpawnVisualParams): SpawnVisualResult {
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

		return {
			nametagY: column.surfaceY + 3, // above player's head
			eyeY: column.surfaceY + 19 / 16 + 1.62 // feet at surfaceY + 19/16 + standing eye offset
		};
	}
}
