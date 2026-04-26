import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, TextHologram } from "./TextHologram";
import { FullBodyHologram } from "./renderer/FullBodyHologram";
import { SpectatorHologram } from "./renderer/SpectatorHologram";
import { TextOnlyHologram } from "./renderer/TextOnlyHologram";

export { TextHologram, type PlayerListLike };

const VALID_RENDERERS = ["spectator", "full_body", "text_only"] as const;
type HologramRenderer = (typeof VALID_RENDERERS)[number];

const raw = (process.env.HOLOGRAM_RENDERER ?? "spectator").toLowerCase();
const renderer: HologramRenderer = (VALID_RENDERERS as readonly string[]).includes(raw)
	? (raw as HologramRenderer)
	: "spectator";

/**
 * Create a {@link TextHologram} instance for a client connection.
 *
 * The renderer variant is selected at startup via the HOLOGRAM_RENDERER env var:
 * - `spectator` (default) — 50% opacity ghost, entity at surfaceY + 3/16
 * - `full_body` — fully opaque standing player, entity at surfaceY + 19/16
 * - `text_only` — floating text labels only, no player entity
 */
export function createHologram(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>): TextHologram {
	switch (renderer) {
		case "full_body": return new FullBodyHologram(client, bot, playerList);
		case "text_only": return new TextOnlyHologram(client, bot, playerList);
		case "spectator":
		default: return new SpectatorHologram(client, bot, playerList);
	}
}
