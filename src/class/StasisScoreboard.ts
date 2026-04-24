import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { StasisManager } from "~/manager/StasisManager";
import { Client } from "./Client";

/**
 * Owns the client-side sidebar scoreboard for a single connected proxy player.
 *
 * Renders a small HUD on the right side of the screen showing live stats:
 * stashed pearl count, online player count, and server TPS.
 *
 * The scoreboard is entirely client-side — it is never sent to 2b2t.
 */
export class StasisScoreboard {

	private static readonly OBJECTIVE = "stasisproxy_sb";

	/** Row labels keyed by row index (top → bottom). */
	private static readonly ROWS = [ "pearls", "players" ] as const;

	/** Update interval handle */
	private updateTimer: NodeJS.Timeout | null = null;

	/** Last cached values per row, used to avoid redundant packet writes */
	private readonly lastValues = new Map<string, string>();

	/** Title text displayed at the top of the scoreboard */
	private readonly title: string;

	constructor(
		private readonly client: MinecraftClient,
		private readonly bot: Mineflayer
	) {

		// First MOTD line — strip the centering padding by taking up to the first newline
		this.title = (Client.proxy.motd.split("\n")[0] ?? "§3§lStasisProxy").trim();
	}

	public attach() {
		this.bot._client.on("respawn", this.onRespawn);

		this.createObjective();
		this.setDisplaySlot();
		this.refreshAll();

		this.updateTimer = setInterval(() => this.refreshAll(), 1000);
	}

	public detach() {
		this.bot._client.off("respawn", this.onRespawn);
		if (this.updateTimer) {
			clearInterval(this.updateTimer);
			this.updateTimer = null;
		}
		this.removeObjective();
	}

	/** Rebuild scoreboard after respawn clears all server-side scoreboard state */
	private readonly onRespawn = () => {

		// Clear cached values so refreshAll re-sends every row.
		this.lastValues.clear();
		this.createObjective();
		this.setDisplaySlot();
		this.refreshAll();
	};

	private refreshAll() {
		try {
			const pearls = StasisManager.pearls;
			const pearlCount = pearls.size;
			const playerCount = new Set(
				[ ...pearls.values() ]
					.map(p => p.ownerId)
					.filter((id): id is string => id !== undefined)
			).size;

			this.setRow("pearls", `§7Pearls:  §f${ pearlCount }`);
			this.setRow("players", `§7Players: §f${ playerCount }`);
		} catch { /* client may have disconnected mid-update */ }
	}

	/**
	 * Set a single row's display text. Each row is a uniquely-keyed scoreboard
	 * "score" entry — the entity name is the visible text and the score number
	 * is its sort position (higher score = higher on the display).
	 */
	private setRow(key: typeof StasisScoreboard.ROWS[number], text: string) {
		const previous = this.lastValues.get(key);
		if (previous === text) return; // no change

		const proto = this.client.serializer.proto;

		// Remove the previous score entry if its display text changed.
		if (previous !== undefined) {
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "scoreboard_score",
				params: {
					itemName: previous,
					action: 1, // remove
					scoreName: StasisScoreboard.OBJECTIVE
				}
			}));
		}

		// Score values define sort order — higher is rendered closer to the top.
		const idx = StasisScoreboard.ROWS.indexOf(key);
		const score = StasisScoreboard.ROWS.length - idx;

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "scoreboard_score",
			params: {
				itemName: text,
				action: 0, // create/update
				scoreName: StasisScoreboard.OBJECTIVE,
				value: score
			}
		}));

		this.lastValues.set(key, text);
	}

	private createObjective() {
		const proto = this.client.serializer.proto;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "scoreboard_objective",
			params: {
				name: StasisScoreboard.OBJECTIVE,
				action: 0, // create
				displayText: JSON.stringify({ text: this.title }),
				type: 0 // integer
			}
		}));
	}

	private setDisplaySlot() {
		const proto = this.client.serializer.proto;
		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "scoreboard_display_objective",
			params: {
				position: 1, // 1 = sidebar
				name: StasisScoreboard.OBJECTIVE
			}
		}));
	}

	private removeObjective() {
		try {
			const proto = this.client.serializer.proto;
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "scoreboard_objective",
				params: {
					name: StasisScoreboard.OBJECTIVE,
					action: 1 // remove
				}
			}));
		} catch { /* client disconnected */ }
	}

}
