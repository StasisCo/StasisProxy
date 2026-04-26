import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, TextHologram } from "./TextHologram";
import { BodyHologram } from "./renderer/BodyHologram";
import { HeadHologram } from "./renderer/HeadHologram";
import { TextOnlyHologram } from "./renderer/TextOnlyHologram";

export { TextHologram, type PlayerListLike };

const VALID_RENDERERS = ["head", "body", "text"] as const;
type HologramRenderer = (typeof VALID_RENDERERS)[number];

const raw = (process.env.HOLOGRAM_RENDERER ?? "head").toLowerCase();
const renderer: HologramRenderer = (VALID_RENDERERS as readonly string[]).includes(raw)
	? (raw as HologramRenderer)
	: "head";

/**
 * Create a {@link TextHologram} instance for a client connection.
 *
 * The renderer variant is selected at startup via the HOLOGRAM_RENDERER env var:
 * - `head` (default) — 50% opacity ghost, head at natural standing eye height
 * - `body` — fully opaque standing player, entity at surfaceY + 19/16
 * - `text` — floating text labels only, no player entity
 */
export function createHologram(client: MinecraftClient, bot: Mineflayer, playerList?: Map<string, PlayerListLike>): TextHologram {
	switch (renderer) {
		case "body": return new BodyHologram(client, bot, playerList);
		case "text": return new TextOnlyHologram(client, bot, playerList);
		case "head":
		default: return new HeadHologram(client, bot, playerList);
	}
}
