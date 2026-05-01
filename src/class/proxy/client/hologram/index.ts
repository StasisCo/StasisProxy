import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { type PlayerListLike, TextHologram } from "./TextHologram";
import { BodyHologram } from "./renderer/BodyHologram";
import { HeadHologram } from "./renderer/HeadHologram";
import { OffHologram } from "./renderer/OffHologram";
import { TextOnlyHologram } from "./renderer/TextOnlyHologram";

export { TextHologram, type PlayerListLike };

export const VALID_RENDERERS = [ "head", "body", "text", "off" ] as const;
export type HologramRenderer = (typeof VALID_RENDERERS)[number];

const envRaw = (process.env.HOLOGRAM_RENDERER ?? "body").toLowerCase();

/** The renderer chosen at startup via the `HOLOGRAM_RENDERER` env var. */
export const DEFAULT_RENDERER: HologramRenderer = (VALID_RENDERERS as readonly string[]).includes(envRaw)
	? (envRaw as HologramRenderer)
	: "body";

/**
 * Create a {@link TextHologram} instance for a client connection.
 *
 * Renderer variants:
 * - `head` (default) — 50% opacity ghost, head at natural standing eye height
 * - `body` — fully opaque standing player, entity at surfaceY + 19/16
 * - `text` — floating text labels only, no player entity
 * - `off` — disabled; no decoration, raw pearl entities are shown as-is
 *
 * @param client - The proxy client to render to
 * @param bot - The upstream mineflayer bot
 * @param playerList - Cached player-list entries (skin properties)
 * @param override - Optional renderer to use instead of the env-var default
 *                   (used by `/hologram` for runtime switching)
 * @param onTracked - Optional callback invoked when the hologram successfully
 *                    spawns a visual for a pearl. Wired by {@link ServerClient}
 *                    to drive {@link PearlFilter.hide}.
 */
export function createHologram(
	client: MinecraftClient,
	bot: Mineflayer,
	playerList?: Map<string, PlayerListLike>,
	override?: HologramRenderer,
	onTracked?: (pearlId: number) => void
): TextHologram {
	const renderer = override ?? DEFAULT_RENDERER;
	let hologram: TextHologram;
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
