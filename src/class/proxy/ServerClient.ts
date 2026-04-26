import chalk from "chalk";
import type { Client as MinecraftClient, PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import type { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { Logger } from "~/class/Logger";
import { createHologram, type HologramRenderer, type TextHologram } from "./client/hologram";
import { ClientCommandManager } from "./ClientCommandManager";
import { HologramCommand } from "./command/HologramCommand";
import { PacketCache, RESERIALIZE_PACKETS, type CachedPacket } from "./PacketCache";
import { PearlFilter } from "./PearlFilter";
import type { PlayerListCache } from "./PlayerListCache";

/**
 * Movement packet names (C→S). These must not reach the upstream server until
 * the client has acknowledged the replayed position — ViaVersion on 2b2t's
 * side tracks the teleport-confirm handshake and kicks if movement arrives
 * first.
 */
const MOVEMENT_PACKETS_CS = new Set([ "position", "position_look", "look", "flying" ]);

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

	private static readonly logger = new Logger(chalk.cyan("CLIENT"));

	/** The connected proxy player's network connection. */
	public readonly client: MinecraftClient;

	/** The upstream mineflayer bot. */
	public readonly bot: Mineflayer;

	/** Per-client command registry & dispatcher. */
	public readonly commandManager: ClientCommandManager;

	/** Hides suspended-stasis pearls. */
	public readonly pearlFilter: PearlFilter;

	private readonly packetCache: PacketCache;
	private readonly playerListCache: PlayerListCache;

	/** The live hologram renderer; replaced wholesale by {@link swapHologram}. */
	private holograms: TextHologram | null = null;

	private readonly disposers: Array<() => void> = [];
	private detached = false;

	/**
	 * Construct a per-client controller. Call {@link ServerClient.attach} to
	 * begin replay and bridging.
	 */
	constructor(
		client: MinecraftClient,
		bot: Mineflayer,
		packetCache: PacketCache,
		playerListCache: PlayerListCache
	) {
		this.client = client;
		this.bot = bot;
		this.packetCache = packetCache;
		this.playerListCache = playerListCache;

		this.commandManager = new ClientCommandManager(this);

		// PearlFilter delegates the "is this pearl hidden?" decision to the
		// current hologram instance via this getter, so swapping renderers
		// automatically swaps the visibility source without re-wiring.
		this.pearlFilter = new PearlFilter(client, eid => this.holograms?.isTracking(eid) ?? false);

		// Built-in test command.
		this.commandManager.register(new HologramCommand());
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
		this.packetCache.updatePosition(Client.physics.lastSent);

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
					this.commandManager.decorateDeclareCommands(pkt.data);
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
					this.commandManager.decorateDeclareCommands(data);
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
				void this.commandManager.interceptClientPacket(this.client, data, meta).then(handled => {
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

	/** Tear down all listeners, holograms, and save home on disconnect. */
	public detach() {
		if (this.detached) return;
		this.detached = true;

		for (const dispose of this.disposers.splice(0)) {
			try { dispose(); } catch { /* ignore */ }
		}
		this.holograms?.detach();
		this.holograms = null;

		// Save current bot position as the new home so pathfinding returns
		// here after reconnect.
		const pos = this.bot.entity?.position;
		if (pos && Number.isFinite(pos.x)) {
			const floored = pos.floored();
			Client.pathfinding.setHome(floored.offset(0.5, 0, 0.5) as Vec3);
			ServerClient.logger.log(`Home saved at ${ floored.x }, ${ floored.y }, ${ floored.z } on disconnect`);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading stored field
		const originalUsername: string = (this.client as any)._originalUsername ?? this.client.username;
		ServerClient.logger.log(`${ originalUsername } lost connection: Disconnected`);
	}

}
