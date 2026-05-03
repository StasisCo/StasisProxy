import chalk from "chalk";
import { Client as ProtocolClient, type PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import type { Vec3 } from "vec3";
import { Logger } from "~/class/Logger";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { Stasis } from "~/client/minecraft/Stasis";
import { prisma } from "~/prisma";
import { ClientCommandManager } from "./ClientCommandManager";
import { createHologram, type HologramRenderer, type TextHologram } from "./Hologram";
import { PacketCache, RESERIALIZE_PACKETS, type CachedPacket } from "./PacketCache";
import { PearlFilter } from "./PearlFilter";
import type { PlayerListCache } from "./PlayerListCache";

/**
 * Reserved windowId for the proxy-injected stasis info chest GUI. Chosen high
 * to avoid collision with any real container window the upstream server might
 * open (vanilla servers typically use 1–99). All C→S packets targeting this
 * windowId (close_window, window_click) are filtered locally and never reach
 * the upstream server, since the window only exists client-side.
 */
const STASIS_GUI_WINDOW_ID = 200;

/** Reserved windowId for the `/stasis` player-list GUI (also virtual). */
const STASIS_LIST_WINDOW_ID = 201;

/** Item id for `minecraft:paper` in 1.20.1. Used as the lore carrier in the GUI. */
const PAPER_ITEM_ID = 884;

/** Item id for `minecraft:player_head` in 1.20.1. */
const PLAYER_HEAD_ITEM_ID = 1059;

/**
 * Render-distance horizontal cap (blocks) used by `/stasis` to filter the
 * tracked stasis set. 8 chunks * 16 = 128, which matches the vanilla default
 * view-distance and avoids surfacing stasis owners far outside what the
 * connected client can actually see.
 */
const STASIS_LIST_RANGE = 128;

/**
 * Movement packet names (C→S). These must not reach the upstream server until
 * the client has acknowledged the replayed position — ViaVersion on 2b2t's
 * side tracks the teleport-confirm handshake and kicks if movement arrives
 * first.
 */
const MOVEMENT_PACKETS_CS = new Set([ "position", "position_look", "look", "flying" ]);

/**
 * Split a hyphenated UUID into the 4 signed-32-bit integers Minecraft uses
 * for `SkullOwner.Id` (the player_head profile UUID NBT representation).
 */
function uuidToInts(uuid: string): [number, number, number, number] {
	const hex = uuid.replace(/-/g, "");
	if (hex.length !== 32) return [ 0, 0, 0, 0 ];
	return [
		parseInt(hex.slice(0, 8), 16) | 0,
		parseInt(hex.slice(8, 16), 16) | 0,
		parseInt(hex.slice(16, 24), 16) | 0,
		parseInt(hex.slice(24, 32), 16) | 0
	];
}

/**
 * Pretty-print a single stasis (db row + currently-tracked pearls) into the
 * NBT-ready array of JSON text components used as item Lore. `highlightPearlId`
 * marks the entry corresponding to the pearl the user clicked, so the right-
 * click flow can show "suspended: true" on that row. Pass `null` from flows
 * that have no specific pearl in focus (e.g. the `/stasis` drill-down).
 */
function buildStasisLoreNbt(stasis: Stasis, highlightPearlId: number | null): string[] {
	const snapshot = {
		id: stasis.id,
		server: stasis.server,
		dimension: stasis.dimension,
		position: { x: stasis.x, y: stasis.y, z: stasis.z },
		ownerId: stasis.ownerId,
		botId: stasis.botId,
		createdAt: stasis.createdAt,
		updatedAt: stasis.updatedAt,
		pearls: stasis.pearls.map(p => ({
			entityId: p.entity.id,
			ownerId: p.ownerId ?? null,
			suspended: highlightPearlId !== null && p.entity.id === highlightPearlId,
			position: p.entity.position
				? { x: p.entity.position.x, y: p.entity.position.y, z: p.entity.position.z }
				: null
		}))
	};

	// JSON.stringify with 2-space indent → one lore line per pretty-printed
	// row. Italics are explicitly disabled because vanilla auto-italicises
	// lore, which makes monospaced JSON unreadable.
	return JSON.stringify(snapshot, null, 2)
		.split("\n")
		.map(line => JSON.stringify({ text: line, color: "white", italic: false }));
}

/**
 * One connected proxy player. Owns the per-connection lifecycle:
 * 1. Replays the upstream world state from {@link PacketCache} in priority order.
 * 2. Bridges packets in both directions, applying {@link PearlFilter}, command
 *    interception, and ViaVersion re-serialization where needed.
 * 3. Spawns and re-spawns the {@link TextHologram} renderer (live-swappable
 *    via {@link ServerClient.swapHologram}).
 * 4. Saves the bot's position as the new home on disconnect.
 */
export class ServerClient {

	private static readonly logger = new Logger(chalk.blue("PROXY"));

	/** The connected proxy player's network connection. */
	public readonly client: ProtocolClient;

	/** The upstream mineflayer bot. */
	public readonly bot: Mineflayer;

	/** Hides suspended-stasis pearls. */
	public readonly pearlFilter: PearlFilter;

	private readonly packetCache: PacketCache;
	private readonly playerListCache: PlayerListCache;

	/** The live hologram renderer; replaced wholesale by {@link swapHologram}. */
	private holograms: TextHologram | null = null;

	/**
	 * Per-slot meaning of the currently-open `/stasis` virtual window. Indexed
	 * by chest slot; `null` = empty/decorative. `kind: "owner"` slots open the
	 * per-player drill-down view on click; `kind: "stasis"` slots are display-
	 * only (their hover tooltip already contains the JSON snapshot). The map
	 * is rebuilt every time the window is (re)populated and cleared when the
	 * client closes the window.
	 */
	private stasisListSlots: Array<
		| { kind: "owner"; ownerId: string }
		| { kind: "stasis"; stasisId: string }
		| null
	> = [];

	private readonly disposers: Array<() => void> = [];
	private detached = false;

	/**
	 * Construct a per-client controller. Call {@link ServerClient.attach} to
	 * begin replay and bridging.
	 */
	constructor(
		client: ProtocolClient,
		bot: Mineflayer,
		packetCache: PacketCache,
		playerListCache: PlayerListCache
	) {
		this.client = client;
		this.bot = bot;
		this.packetCache = packetCache;
		this.playerListCache = playerListCache;

		// PearlFilter delegates the "is this pearl hidden?" decision to the
		// current hologram instance via this getter, so swapping renderers
		// automatically swaps the visibility source without re-wiring.
		this.pearlFilter = new PearlFilter(client, eid => this.holograms?.isTracking(eid) ?? false);
	}

	/**
	 * Replay cached state, install bridges, and spawn the initial hologram.
	 * Safe to call exactly once per instance.
	 */
	public attach() {

		// Sync cached position to what 2b2t actually thinks (lastSent), with
		// explicit absolute flags. Using bot.entity.position would be wrong —
		// the physics simulation keeps updating it every tick, drifting from
		// what 2b2t knows. Preserving original flags would also be wrong — if
		// 2b2t sent a relative correction, our absolute coords would be
		// interpreted as offsets.
		this.packetCache.updatePosition(MinecraftClient.physics.lastSent);

		// Hold back the position packet — defer it until AFTER login/respawn
		// (so the client is in the play state) but BEFORE any chunk packet
		// (so the loading-terrain screen waits for chunks at the real coords
		// instead of dismissing at the client's default 0,0). The screen in
		// 1.20.1 dismisses on `position` AND when a quorum of chunks around
		// the player's known position have loaded — by injecting position
		// right after login, the client's known position is correct, so the
		// screen stays up while we replay chunks at that location.
		const packets = this.packetCache.getReplayPackets();
		const chunkCount = this.packetCache.size("map_chunk");
		const lightCount = this.packetCache.size("update_light");
		const viewPos = this.packetCache.peek("update_view_position");
		ServerClient.logger.log(`Replaying ${ packets.length } cached packets (${ chunkCount } chunks, ${ lightCount } lights, viewPos=${ viewPos ? `${ viewPos.data.chunkX },${ viewPos.data.chunkZ }` : "MISSING" })...`);

		const positionPkt: CachedPacket | null = packets.find(p => p.name === "position") ?? null;

		let replayedChunks = 0;
		let failedPackets = 0;
		let playerListSent = false;
		let positionSent = false;

		const sendPositionNow = () => {
			if (positionSent || !positionPkt) return;
			positionSent = true;
			try {
				this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", { name: positionPkt.name, params: positionPkt.data }));
			} catch (err) {
				ServerClient.logger.warn("Failed to replay position:", err);
			}
		};

		for (const pkt of packets) {
			if (pkt.name === "position") continue; // injected via sendPositionNow()

			// Inject position right before the first chunk so the client's
			// known location is set before terrain starts arriving.
			if (!positionSent && (pkt.name === "map_chunk" || pkt.name === "update_light")) {
				sendPositionNow();
			}

			// Never replay entity packets for suspended pearls — hidden client-side.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw packet data
			const eid = (pkt.data as any).entityId;
			if (eid !== undefined && this.pearlFilter.isHidden(eid)) continue;

			// Inject the player-list ADD once, after login/respawn but before
			// any entity/chunk packet (so player skins resolve correctly).
			if (!playerListSent && pkt.name !== "login" && pkt.name !== "respawn") {
				playerListSent = true;
				this.playerListCache.warmStart(this.client);
			}

			try {
				if (pkt.name === "declare_commands") {

					// Decorate so our commands appear in tab-completion. The
					// cached buffer is now stale — must re-serialize.
					ClientCommandManager.decorateDeclareCommands(pkt.data);
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", { name: pkt.name, params: pkt.data }));
				} else if (pkt.name === "update_view_position" || RESERIALIZE_PACKETS.has(pkt.name)) {

					// Re-serialize from parsed data: update_view_position was
					// modified above, RESERIALIZE_PACKETS have ViaVersion extra
					// bytes. Manual serialization + writeRaw avoids the async
					// serializer reordering these AFTER the writeRaw'd packets.
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", { name: pkt.name, params: pkt.data }));
				} else {

					// Default: send the raw wire buffer. structuredClone'ing
					// Buffer fields would corrupt them.
					this.client.writeRaw(pkt.buffer);
				}
				if (pkt.name === "map_chunk") replayedChunks++;
			} catch (err) {
				failedPackets++;
				ServerClient.logger.warn(`Failed to replay ${ pkt.name } (buf=${ pkt.buffer.length }b):`, err);
			}
		}

		// Cache had no chunks queued — still send position so we don't
		// silently drop it.
		sendPositionNow();

		ServerClient.logger.log(`Replay done: ${ replayedChunks } chunks sent, ${ failedPackets } failures`);

		// ── Synthesize weather state if not captured in cache ──
		// If the bot joined 2b2t while it was already raining, no game_state_change
		// packet would have been cached (servers only emit on change). Fall back to
		// mineflayer's tracked isRaining / rainState / thunderState.
		{
			const gsc = "game_state_change";
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rainState not in typedefs
			const rainLevel: number = (this.bot as any).rainState ?? 0;
			if (this.bot.isRaining && !this.packetCache.peek(gsc, "1")) {
				try {
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", {
						name: gsc, params: { reason: 1, gameMode: 0 }
					}));
				} catch { /* client may have disconnected */ }
			}
			if (rainLevel > 0 && !this.packetCache.peek(gsc, "7")) {
				try {
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", {
						name: gsc, params: { reason: 7, gameMode: rainLevel }
					}));
				} catch { /* client may have disconnected */ }
			}
			if (this.bot.thunderState > 0 && !this.packetCache.peek(gsc, "8")) {
				try {
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", {
						name: gsc, params: { reason: 8, gameMode: this.bot.thunderState }
					}));
				} catch { /* client may have disconnected */ }
			}
		}

		// The replayed position has a stale teleportId — the client will send
		// teleport_confirm for it which must NOT reach 2b2t (already confirmed).
		let replayTeleportId: number | null = (positionPkt?.data as { teleportId?: number })?.teleportId ?? null;

		// Allow movement immediately if there was no position to confirm,
		// otherwise block until teleport_confirm arrives.
		let movementAllowed = replayTeleportId === null;

		// ── Bridge: server → player ──
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw packet data
		const onServerPacket = (data: any, meta: PacketMeta, buffer: Buffer) => {
			if (meta.name === "keep_alive" || meta.name === "kick_disconnect") return;

			// Filter entity packets for suspended pearls.
			if (data != null && data.entityId !== undefined && this.pearlFilter.isHidden(data.entityId)) return;
			if (meta.name === "entity_destroy" && Array.isArray(data?.entityIds)) {
				const filtered = (data.entityIds as number[]).filter(id => !this.pearlFilter.isHidden(id));
				if (filtered.length === 0) return;
				if (filtered.length !== data.entityIds.length) {
					try {
						this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", {
							name: "entity_destroy",
							params: { entityIds: filtered }
						}));
					} catch { /* client may have disconnected */ }
					return;
				}
			}

			try {
				if (meta.name === "declare_commands") {

					// Decorate live updates too, otherwise switching dimensions
					// would wipe our literals from tab-completion.
					ClientCommandManager.decorateDeclareCommands(data);
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", { name: meta.name, params: data }));
				} else if (RESERIALIZE_PACKETS.has(meta.name)) {

					// Re-serialize to fix ViaVersion wire-format quirks.
					this.client.writeRaw(this.client.serializer.proto.createPacketBuffer("packet", { name: meta.name, params: data }));
				} else {
					this.client.writeRaw(buffer);
				}
			} catch { /* client may have disconnected */ }
		};

		// ── Bridge: player → server ──
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw packet data
		const onClientPacket = (data: any, meta: PacketMeta, _buffer: Buffer, fullBuffer: Buffer) => {
			if (meta.name === "keep_alive") return;

			// Right-click on a hologram fake-player → open stasis info GUI.
			// Both mouse=0 (interact) and mouse=2 (interact_at) fire on a single
			// click; we open on `interact` and silently swallow `interact_at`
			// so the upstream server never receives the bogus entity ID.
			if (meta.name === "use_entity" && this.holograms) {
				const target = data?.target;
				if (typeof target === "number") {
					const pearlId = this.holograms.getPearlIdByEntity(target);
					if (pearlId !== null) {
						if (data.mouse === 0) void this.openStasisGui(pearlId);
						return;
					}
				}
			}

			// Filter all client→server traffic targeting our virtual windows
			// (close, click, etc.) — the upstream server never opened them.
			if (
				(meta.name === "close_window" || meta.name === "window_click")
				&& (data?.windowId === STASIS_GUI_WINDOW_ID || data?.windowId === STASIS_LIST_WINDOW_ID)
			) {
				if (meta.name === "close_window" && data.windowId === STASIS_LIST_WINDOW_ID) {
					this.stasisListSlots = [];
				}
				if (meta.name === "window_click" && data.windowId === STASIS_LIST_WINDOW_ID) {
					void this.onStasisListClick(data?.slot);
				}
				return;
			}

			// Filter the teleport_confirm for our replayed position. We use it
			// as the signal to unblock movement forwarding — ViaVersion requires
			// teleport_confirm before it accepts movement, and since we filtered
			// the confirm the client would otherwise be kicked the moment it
			// sends its first position_look.
			if (meta.name === "teleport_confirm" && replayTeleportId !== null && data?.teleportId === replayTeleportId) {
				replayTeleportId = null;
				movementAllowed = true;
				return;
			}

			// Drop movement until the replayed position has been confirmed.
			if (!movementAllowed && MOVEMENT_PACKETS_CS.has(meta.name)) return;

			// Intercept commands. tryHandle is async but commands are local
			// so the latency is negligible; we await before forwarding the
			// fall-through case so unknown commands aren't dispatched twice.
			if (meta.name === "chat_command" || meta.name === "chat_command_signed" || meta.name === "chat") {
				void ClientCommandManager.interceptClientPacket(this.client, this, data, meta).then(handled => {
					if (handled) return;
					try {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- writeRaw bypasses serialization
						(this.bot._client as any).writeRaw(fullBuffer);
					} catch { /* server may have disconnected */ }
				});
				return;
			}

			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- writeRaw bypasses serialization
				(this.bot._client as any).writeRaw(fullBuffer);
			} catch { /* server may have disconnected */ }
		};

		this.bot._client.on("packet", onServerPacket);
		this.client.on("packet", onClientPacket);
		this.disposers.push(() => this.bot._client.off("packet", onServerPacket));
		this.disposers.push(() => this.client.off("packet", onClientPacket));

		// Initial hologram. The onTracked callback drives PearlFilter.hide so
		// pearls only get hidden once their visual is actually live.
		this.holograms = createHologram(
			this.client,
			this.bot,
			this.playerListCache as unknown as Map<string, never>,
			undefined,
			id => this.pearlFilter.hide(id)
		);
		this.holograms.attach();

		// Disconnect handlers.
		const onEnd = () => this.detach();
		const onError = (err: Error) => ServerClient.logger.warn(`Client error (non-fatal): ${ err?.message }`);
		this.client.on("end", onEnd);
		this.client.on("error", onError);
		this.disposers.push(() => this.client.off("end", onEnd));
		this.disposers.push(() => this.client.off("error", onError));
	}

	/**
	 * Replace the current hologram renderer at runtime. Detaches the previous
	 * renderer (sending entity_destroy) before spawning the new one.
	 */
	public swapHologram(renderer: HologramRenderer) {
		this.holograms?.detach();
		this.holograms = createHologram(
			this.client,
			this.bot,
			this.playerListCache as unknown as Map<string, never>,
			renderer,
			id => this.pearlFilter.hide(id)
		);
		this.holograms.attach();
		ServerClient.logger.log(`Hologram renderer swapped to ${ renderer }`);
	}

	/**
	 * Open the proxy-injected stasis info GUI for the pearl at `pearlId`. The
	 * GUI is a 3-row chest containing one paper item whose lore is a pretty-
	 * printed JSON dump of the stasis (db row + currently-tracked pearls).
	 *
	 * The window is rendered entirely client-side using {@link STASIS_GUI_WINDOW_ID};
	 * close/click packets for that windowId are filtered in the C→S bridge so
	 * the upstream server never sees this virtual interaction.
	 */
	private async openStasisGui(pearlId: number) {
		const pearl = StasisManager.pearls.get(pearlId);
		if (!pearl?.entity?.position) return;

		const stasis = await Stasis.from(pearl).catch(() => null);
		if (!stasis) {
			ServerClient.logger.warn(`No stasis found for pearl ${ pearlId }`);
			return;
		}

		this.renderStasisInfoGui(stasis, pearlId);
	}

	/**
	 * Render (open + populate) the 9×3 stasis-info chest for `stasis`. Shared
	 * between the right-click-hologram flow and the `/stasis` drill-down
	 * "click a chamber head" flow so both surfaces show identical content.
	 * `highlightPearlId` flags one pearl as `suspended: true` in the JSON
	 * snapshot when known (right-click flow); pass `null` otherwise.
	 */
	private renderStasisInfoGui(stasis: Stasis, highlightPearlId: number | null) {
		const loreNbt = buildStasisLoreNbt(stasis, highlightPearlId);
		const titleNbt = JSON.stringify({ text: `Stasis ${ stasis.id.slice(0, 8) }`, color: "aqua", italic: false });

		const proto = this.client.serializer.proto;

		try {
			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "open_window",
				params: {
					windowId: STASIS_GUI_WINDOW_ID,
					inventoryType: 2, // minecraft:generic_9x3
					windowTitle: JSON.stringify({ text: "Stasis Info", color: "dark_aqua", bold: true })
				}
			}));

			// 27 slots; place the paper at slot 13 (centre of 3×9 grid).
			const items: Array<unknown> = new Array(27).fill({ present: false });
			items[13] = {
				present: true,
				itemId: PAPER_ITEM_ID,
				itemCount: 1,
				nbtData: {
					type: "compound",
					name: "",
					value: {
						display: {
							type: "compound",
							value: {
								Name: { type: "string", value: titleNbt },
								Lore: {
									type: "list",
									value: { type: "string", value: loreNbt }
								}
							}
						}
					}
				}
			};

			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "window_items",
				params: {
					windowId: STASIS_GUI_WINDOW_ID,
					stateId: 0,
					items,
					carriedItem: { present: false }
				}
			}));
		} catch (err) {
			ServerClient.logger.warn(`Failed to open stasis GUI: ${ (err as Error)?.message }`);
		}
	}

	/**
	 * Build & open the `/stasis` player-list GUI: one player_head per unique
	 * stasis owner whose chamber lies within {@link STASIS_LIST_RANGE} blocks
	 * of the bot. Heads are textured from the upstream tab-list cache when
	 * available so they match what the player already sees in-world; usernames
	 * fall back to the persisted `Player` record, then to the raw UUID.
	 *
	 * The GUI auto-sizes to the smallest 9×N chest (rows 1–6) that fits the
	 * unique owner count and silently truncates beyond 54 entries.
	 */
	public async openStasisListGui(): Promise<void> {
		try {
			const origin = this.bot.entity?.position;
			if (!origin) return;

			// Group stasises by ownerId, keeping only those in range.
			const byOwner = new Map<string, Stasis[]>();
			for (const stasis of Stasis.instances.values()) {
				if (!stasis.ownerId) continue;
				const dx = stasis.x + 0.5 - origin.x;
				const dy = stasis.y + 0.5 - origin.y;
				const dz = stasis.z + 0.5 - origin.z;
				if (Math.hypot(dx, dy, dz) > STASIS_LIST_RANGE) continue;
				const list = byOwner.get(stasis.ownerId);
				if (list) list.push(stasis);
				else byOwner.set(stasis.ownerId, [ stasis ]);
			}

			if (byOwner.size === 0) {
				ClientCommandManager.sendSystemMessage(this.client, "§7No stasis chambers in render distance.");
				return;
			}

			// Pick smallest chest size that fits; cap at 54 (9x6) and truncate.
			const owners = [ ...byOwner.entries() ].slice(0, 54);
			const rows = Math.min(6, Math.max(1, Math.ceil(owners.length / 9)));
			const totalSlots = rows * 9;
			const inventoryType = rows - 1; // 0=9x1 .. 5=9x6

			const proto = this.client.serializer.proto;

			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "open_window",
				params: {
					windowId: STASIS_LIST_WINDOW_ID,
					inventoryType,
					windowTitle: JSON.stringify({ text: "Stasis Owners", color: "dark_aqua", bold: true })
				}
			}));

			// Resolve usernames + skin properties for each owner in parallel.
			const items: Array<unknown> = new Array(totalSlots).fill({ present: false });
			this.stasisListSlots = new Array(totalSlots).fill(null);
			await Promise.all(owners.map(async([ ownerId, list ], idx) => {
				const head = await this.buildPlayerHead(ownerId, list);
				items[idx] = head;
				this.stasisListSlots[idx] = { kind: "owner", ownerId };
			}));

			this.client.writeRaw(proto.createPacketBuffer("packet", {
				name: "window_items",
				params: {
					windowId: STASIS_LIST_WINDOW_ID,
					stateId: 0,
					items,
					carriedItem: { present: false }
				}
			}));
		} catch (err) {
			ServerClient.logger.warn(`Failed to open stasis list GUI: ${ (err as Error)?.message }`);
		}
	}

	/**
	 * Handle a click in the `/stasis` virtual window. Owner-head slots swap
	 * the window contents in-place to show one head per chamber that owner
	 * controls; chamber-head slots are inert (their tooltip is the payload).
	 * Out-of-range / empty slots are ignored. The click packet itself is
	 * already swallowed by the upstream filter.
	 */
	private async onStasisListClick(slot: number | undefined): Promise<void> {
		if (typeof slot !== "number") return;
		const entry = this.stasisListSlots[slot];
		if (!entry) return;

		if (entry.kind === "owner") {
			const stasises = [ ...Stasis.instances.values() ].filter(s => s.ownerId === entry.ownerId);
			if (stasises.length === 0) {
				ClientCommandManager.sendSystemMessage(this.client, "§7That player no longer has any tracked stasis.");
				return;
			}
			await this.renderStasisDetailGui(entry.ownerId, stasises);
			return;
		}

		if (entry.kind === "stasis") {
			const stasis = Stasis.instances.get(entry.stasisId);
			if (!stasis) {
				ClientCommandManager.sendSystemMessage(this.client, "§7That stasis is no longer tracked.");
				return;
			}

			// Clear the list slot map: the upcoming open_window for the info
			// GUI uses a different windowId, and the client closes the list
			// implicitly. Stale entries would mis-route any racing click.
			this.stasisListSlots = [];
			this.renderStasisInfoGui(stasis, null);
		}
	}

	/**
	 * Re-populate the already-open `/stasis` window with one player_head per
	 * stasis owned by `ownerId`. Each head shows the owner's skin (so the
	 * grid visually reads as "all of <player>'s chambers") and its hover
	 * tooltip carries the full pretty-printed JSON snapshot — identical to
	 * what right-clicking a hologram fake-player produces.
	 *
	 * No `open_window` is sent: re-using the live windowId keeps the cursor
	 * item state consistent and avoids the open/close flicker.
	 */
	private async renderStasisDetailGui(ownerId: string, stasises: Stasis[]): Promise<void> {
		const proto = this.client.serializer.proto;

		const capped = stasises.slice(0, 54);
		const totalSlots = this.stasisListSlots.length || 27;

		// Resolve owner skin once; every detail head reuses it.
		let username: string | null = null;
		let properties: Array<{ name: string; value: string; signature?: string }> = [];
		const tabEntry = this.playerListCache.get(ownerId);
		if (tabEntry) {
			username = tabEntry.name || null;
			properties = tabEntry.properties ?? [];
		}
		if (!username) {
			try {
				const row = await prisma.player.findUnique({ where: { id: ownerId }, select: { username: true }});
				if (row?.username) username = row.username;
			} catch { /* ignore */ }
		}

		const items: Array<unknown> = new Array(totalSlots).fill({ present: false });
		const slotMap: ServerClient["stasisListSlots"] = new Array(totalSlots).fill(null);

		for (let i = 0; i < capped.length && i < totalSlots; i++) {
			const stasis = capped[i]!;
			items[i] = this.buildStasisDetailHead(stasis, ownerId, username, properties);
			slotMap[i] = { kind: "stasis", stasisId: stasis.id };
		}
		this.stasisListSlots = slotMap;

		this.client.writeRaw(proto.createPacketBuffer("packet", {
			name: "window_items",
			params: {
				windowId: STASIS_LIST_WINDOW_ID,
				stateId: 0,
				items,
				carriedItem: { present: false }
			}
		}));
	}

	/**
	 * Build a single player_head slot representing one specific stasis. Wears
	 * the chamber owner's skin (to keep the per-owner grid visually unified)
	 * and carries the full JSON-pretty-printed snapshot as Lore so the
	 * tooltip matches the right-click hologram view.
	 */
	private buildStasisDetailHead(
		stasis: Stasis,
		ownerId: string,
		username: string | null,
		properties: Array<{ name: string; value: string; signature?: string }>
	): unknown {
		const nameNbt = JSON.stringify({
			text: `${ stasis.dimension } §f${ stasis.x } ${ stasis.y } ${ stasis.z }`,
			color: "aqua",
			italic: false,
			bold: true
		});
		const loreNbt = buildStasisLoreNbt(stasis, null);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prismarine-nbt structural type
		const skullOwnerValue: Record<string, any> = {
			Id: { type: "intArray", value: uuidToInts(ownerId) },
			Name: { type: "string", value: username ?? ownerId }
		};
		const texture = properties.find(p => p.name === "textures");
		if (texture) {
			const texEntry: Record<string, unknown> = { Value: { type: "string", value: texture.value }};
			if (texture.signature) texEntry.Signature = { type: "string", value: texture.signature };
			skullOwnerValue.Properties = {
				type: "compound",
				value: {
					textures: {
						type: "list",
						value: { type: "compound", value: [ texEntry ]}
					}
				}
			};
		}

		return {
			present: true,
			itemId: PLAYER_HEAD_ITEM_ID,
			itemCount: 1,
			nbtData: {
				type: "compound",
				name: "",
				value: {
					display: {
						type: "compound",
						value: {
							Name: { type: "string", value: nameNbt },
							Lore: { type: "list", value: { type: "string", value: loreNbt }}
						}
					},
					SkullOwner: {
						type: "compound",
						value: skullOwnerValue
					}
				}
			}
		};
	}

	/**
	 * Construct the slot payload for a single player_head representing
	 * `ownerId`. Username comes from the upstream tab-list when present
	 * (already cached for skin rendering), then from the persisted `Player`
	 * row, then falls back to the UUID. Skin texture properties are copied
	 * verbatim from the tab-list when available; otherwise the head is left
	 * untextured (vanilla client renders the default Steve skin).
	 */
	private async buildPlayerHead(ownerId: string, list: Stasis[]): Promise<unknown> {

		// Username + skin properties (best-effort).
		let username: string | null = null;
		let properties: Array<{ name: string; value: string; signature?: string }> = [];

		const tabEntry = this.playerListCache.get(ownerId);
		if (tabEntry) {
			username = tabEntry.name || null;
			properties = tabEntry.properties ?? [];
		}

		if (!username) {
			try {
				const row = await prisma.player.findUnique({ where: { id: ownerId }, select: { username: true }});
				if (row?.username) username = row.username;
			} catch { /* ignore */ }
		}

		const displayName = username ?? ownerId;

		// Build display.Name + Lore (one line per chamber: dim x,y,z).
		const nameNbt = JSON.stringify({ text: displayName, color: "yellow", italic: false, bold: true });
		const loreLines: string[] = [
			JSON.stringify({ text: `${ list.length } chamber${ list.length === 1 ? "" : "s" }`, color: "gray", italic: false })
		];
		for (const s of list.slice(0, 8)) {
			loreLines.push(JSON.stringify({
				text: `§8• §7${ s.dimension } §f${ s.x } ${ s.y } ${ s.z }`,
				italic: false
			}));
		}
		if (list.length > 8) {
			loreLines.push(JSON.stringify({ text: `…and ${ list.length - 8 } more`, color: "dark_gray", italic: false }));
		}

		// Compound NBT for the slot.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prismarine-nbt structural type
		const skullOwnerValue: Record<string, any> = {
			Id: { type: "intArray", value: uuidToInts(ownerId) },
			Name: { type: "string", value: username ?? ownerId }
		};

		const texture = properties.find(p => p.name === "textures");
		if (texture) {
			const texEntry: Record<string, unknown> = { Value: { type: "string", value: texture.value }};
			if (texture.signature) texEntry.Signature = { type: "string", value: texture.signature };
			skullOwnerValue.Properties = {
				type: "compound",
				value: {
					textures: {
						type: "list",
						value: { type: "compound", value: [ texEntry ]}
					}
				}
			};
		}

		return {
			present: true,
			itemId: PLAYER_HEAD_ITEM_ID,
			itemCount: 1,
			nbtData: {
				type: "compound",
				name: "",
				value: {
					display: {
						type: "compound",
						value: {
							Name: { type: "string", value: nameNbt },
							Lore: { type: "list", value: { type: "string", value: loreLines }}
						}
					},
					SkullOwner: {
						type: "compound",
						value: skullOwnerValue
					}
				}
			}
		};
	}

	/** Tear down all listeners, holograms, and save home on disconnect. */
	public detach() {
		if (this.detached) return;
		this.detached = true;

		for (const dispose of this.disposers.splice(0)) {
			try {
				dispose();
			} catch { /* ignore */ }
		}
		this.holograms?.detach();
		this.holograms = null;

		// Save current bot position as the new home so pathfinding returns
		// here after reconnect.
		const pos = this.bot.entity?.position;
		if (pos && Number.isFinite(pos.x)) {
			const floored = pos.floored();
			MinecraftClient.pathfinding.setHome(floored.offset(0.5, 0, 0.5) as Vec3);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading stored field
		const originalUsername: string = (this.client as any)._originalUsername ?? this.client.username;
		ServerClient.logger.log(`${ originalUsername } lost connection: Disconnected`);
	}

}
