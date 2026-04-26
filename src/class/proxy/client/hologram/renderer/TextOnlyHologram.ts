import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, type SpawnVisualParams, type SpawnVisualResult, TextHologram } from "../TextHologram";

/**
 * Renders only floating text labels above each stasis chamber — no player entity.
 *
 * No player_info or named_entity_spawn is sent; just the armor-stand nametag
 * lines positioned at the water surface.
 */
export class TextOnlyHologram extends TextHologram {

	constructor(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>) {
		super(client, bot, playerList);
	}

	/**
	 * No visual entity — return the Y level for the nametag lines and nothing else.
	 *
	 * @returns The Y level at which nametag armor stands should be placed.
	 */
	protected override spawnVisual({ column }: SpawnVisualParams): SpawnVisualResult {
		return {
			nametagY: column.surfaceY + 1, // float labels just above the water surface
			eyeY: column.surfaceY + 1 // no entity — rotation is a no-op, value is irrelevant
		};
	}
}
