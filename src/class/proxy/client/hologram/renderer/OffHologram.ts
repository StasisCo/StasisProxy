import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, type SpawnVisualParams, type SpawnVisualResult, TextHologram } from "../TextHologram";

/**
 * No-op hologram renderer.
 *
 * Does not spawn nametag stands, fake players, or hide pearls. Pearls are
 * shown to the client exactly as the upstream server sent them. Useful when
 * the player wants to see the raw pearl entities (debugging, screenshots,
 * etc.) without any proxy-side decoration.
 */
export class OffHologram extends TextHologram {

	constructor(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>) {
		super(client, bot, playerList);
	}

	/** No tracking — `attach()` is a no-op so this is never invoked. */
	protected override spawnVisual(_params: SpawnVisualParams): SpawnVisualResult {
		return { nametagY: 0, eyeY: 0 };
	}

	/** Skip all listener wiring and pearl tracking. */
	public override attach(): void { /* intentionally empty */ }

	/** Nothing to tear down. */
	public override detach(): void { /* intentionally empty */ }

}
