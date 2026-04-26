import type { Client as MinecraftClient, PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Server } from "./Server";

/**
 * One row of player-list state, built from `player_info` ADD packets and
 * mutated by UPDATE actions. Removed when `player_remove` arrives.
 */
export interface PlayerListEntry {
	uuid: string;
	name: string;
	properties: Array<{ name: string; value: string; signature?: string }>;
	gamemode: number;

	/** varint: 1 = listed in tab, 0 = unlisted */
	listed: number;
	latency: number;
}

/**
 * Tracks the upstream server's player-list state by absorbing `player_info`
 * and `player_remove` packets. When a proxy client connects, {@link warmStart}
 * synthesizes a single ADD packet so the tab list and player skins render
 * immediately without waiting for the next upstream `player_info`.
 */
export class PlayerListCache {

	private readonly entries = new Map<string, PlayerListEntry>();

	/**
	 * Creates a new PlayerListCache and immediately begins recording player
	 * list packets from the bot's upstream server connection.
	 * @param bot - The mineflayer bot whose upstream packets should be tracked
	 */
	constructor(private readonly bot: Mineflayer) {
		bot._client.on("packet", this.onPacket);
	}

	/** Number of tracked players. */
	public get size(): number {
		return this.entries.size;
	}

	/** Iterate the live entry view (do not retain the iterator across ticks). */
	public values(): IterableIterator<PlayerListEntry> {
		return this.entries.values();
	}

	/** Look up a single entry by UUID. */
	public get(uuid: string): PlayerListEntry | undefined {
		return this.entries.get(uuid);
	}

	/**
	 * Send a single synthetic `player_info` ADD packet containing the entire
	 * current player list. Must be sent after the client's login/respawn but
	 * before any entity packets so player skins render correctly.
	 */
	public warmStart(client: MinecraftClient) {
		if (this.entries.size === 0) return;
		try {
			client.writeRaw(client.serializer.proto.createPacketBuffer("packet", {
				name: "player_info",
				params: {
					action: {
						add_player: true,
						initialize_chat: false,
						update_game_mode: true,
						update_listed: true,
						update_latency: true,
						update_display_name: false
					},
					data: [ ...this.entries.values() ].map(p => ({
						uuid: p.uuid,
						player: { name: p.name, properties: p.properties },
						gamemode: p.gamemode,
						listed: p.listed,
						latency: p.latency
					}))
				}
			}));
		} catch (err) {
			Server.logger.warn("Failed to warm-start player list:", err);
		}
	}

	/** Detach the upstream packet listener. Should be called on shutdown. */
	public close() {
		this.bot._client.off("packet", this.onPacket);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol data
	private readonly onPacket = (data: any, meta: PacketMeta) => {
		if (meta.name === "player_remove") {
			for (const uuid of data?.players ?? []) this.entries.delete(uuid);
			return;
		}

		if (meta.name !== "player_info") return;

		const action = data?.action ?? {};
		for (const entry of data?.data ?? []) {
			const uuid: string = entry.uuid;
			if (action.add_player) {
				this.entries.set(uuid, {
					uuid,
					name: entry.player?.name ?? "",
					properties: entry.player?.properties ?? [],
					gamemode: entry.gamemode ?? 0,
					listed: entry.listed ?? 1,
					latency: entry.latency ?? 0
				});
			} else {
				const existing = this.entries.get(uuid);
				if (existing) {
					if (action.update_game_mode && "gamemode" in entry) existing.gamemode = entry.gamemode;
					if (action.update_listed && "listed" in entry) existing.listed = entry.listed;
					if (action.update_latency && "latency" in entry) existing.latency = entry.latency;
				}
			}
		}
	};

}
