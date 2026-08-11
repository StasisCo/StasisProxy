import chalk from "chalk";
import { Client as ProtocolClient, type PacketMeta } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { prisma } from "~/prisma";
import type { ClientConfig } from "~/schema/server/minecraft/zClientConfig";
import { ClientCommands } from "./ClientCommands";
import { createHologram, type HologramRenderer, type TextHologram } from "./Hologram";
import { PacketCache, RESERIALIZE_PACKETS, type CachedPacket } from "./PacketCache";
import type { PlayerListCache } from "./PlayerListCache";

/**
 * Movement packet names (C→S). These must not reach the upstream server until
 * the client has acknowledged the replayed position — ViaVersion on 2b2t's
 * side tracks the teleport-confirm handshake and kicks if movement arrives
 * first.
 */
const MOVEMENT_PACKETS_CS = new Set([ "position", "position_look", "look", "flying" ]);

/**
 * S→C packet names that we drop from the bridge to relieve client back-pressure.
 * At entity-dense locations (e.g. mob farms with 1k+ entities) the upstream
 * sends thousands of these per second; the client's socket fills, queueing
 * keep_alive responses and inflating measured ping.
 *
 * `entity_velocity`: vanilla clients predict velocity from the position deltas
 * in {@code rel_entity_move} / {@code entity_teleport}, so dropping these has
 * essentially no visible effect while removing one packet per moving entity
 * per tick.
 *
 * The one exception — enforced at the drop site — is the player's OWN entity:
 * a self entity_velocity is the server applying knockback/push to the player,
 * the client is required to mirror it, and the anticheat verifies that it did.
 */
const DROP_S2C = new Set([ "entity_velocity" ]);

/**
 * One connected proxy player. Owns the per-connection lifecycle:
 * 1. Replays the upstream world state from {@link PacketCache} in priority order.
 * 2. Bridges packets in both directions, applying command interception and
 *    ViaVersion re-serialization where needed.
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

	/** The real UUID of the connecting player (before bot-swap). */
	public readonly playerId: string;

	private readonly packetCache: PacketCache;
	private readonly playerListCache: PlayerListCache;

	/** Parsed client config loaded from the DB on connect. */
	private config: ClientConfig;

	/** The live hologram renderer; replaced wholesale by {@link swapHologram}. */
	private holograms: TextHologram | null = null;

	private readonly disposers: Array<() => void> = [];
	private detached = false;

	/**
	 * Last position reported by the proxied player via position / position_look
	 * packets. Used on disconnect to set the pathfinding home — bot.entity.position
	 * is not updated while the proxy is connected (PhysicsManager skips simulation),
	 * so it would point at stale coordinates from before the player connected.
	 */
	private lastClientPos: { x: number; y: number; z: number } | null = null;

	/**
	 * Wire state established by the proxied player's own packets. The server's belief about
	 * rotation, ground state and sprint/sneak follows whatever the client last sent, so this
	 * is what the bot must resume from on disconnect — its own trackers are frozen at their
	 * pre-session values. Yaw/pitch are Notchian degrees, as carried on the wire.
	 */
	private clientYaw = 0;
	private clientPitch = 0;
	private clientOnGround = false;
	private clientSprint = false;
	private clientSneak = false;
	private lastClientMoveAt = 0;

	/** Latest upstream teleport not yet confirmed by the client, for the detach failsafe. */
	private pendingTeleportId: number | null = null;
	private lastServerTeleportAt = 0;

	/**
	 * Last position reported by the proxied player, or null if no movement
	 * packet has been observed yet. Read by client commands that need the
	 * player's authoritative position (e.g. `/stasis save` searching nearby).
	 */
	public get playerPosition(): { x: number; y: number; z: number } | null {
		return this.lastClientPos;
	}

	/**
	 * Construct a per-client controller. Call {@link ServerClient.attach} to
	 * begin replay and bridging.
	 */
	constructor(
		client: ProtocolClient,
		bot: Mineflayer,
		packetCache: PacketCache,
		playerListCache: PlayerListCache,
		playerId: string,
		config: ClientConfig
	) {
		this.client = client;
		this.bot = bot;
		this.packetCache = packetCache;
		this.playerListCache = playerListCache;
		this.playerId = playerId;
		this.config = config;
	}

	/**
	 * Replay cached state, install bridges, and spawn the initial hologram.
	 * Safe to call exactly once per instance.
	 */
	public attach() {

		// Hand the wire over clean: if the bot was mid-walk with sprint asserted, the client's
		// vanilla sprint logic (which assumes a fresh, non-sprinting session) would emit a
		// START_SPRINTING the server already holds — a duplicate status edge — the moment the
		// player moves. Drop it bot-side before the client takes over.
		MinecraftClient.physics.dropSprint();

		// The client starts from what the server currently believes.
		this.clientYaw = MinecraftClient.physics.lastSent.yaw;
		this.clientPitch = MinecraftClient.physics.lastSent.pitch;
		this.clientOnGround = MinecraftClient.physics.lastSent.onGround;

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
					ClientCommands.decorateDeclareCommands(pkt.data);
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

			// Back-pressure drops must never eat the player's own knockback. A swallowed self
			// entity_velocity is an ignored knockback from the anticheat's point of view — one
			// setback per push, which in entity-dense places means dozens of corrections per
			// second (a permanent teleport storm) until the client connection gives out.
			if (DROP_S2C.has(meta.name) && data?.entityId !== this.bot.entity?.id) return;

			// Track live teleports. While a client is attached, mineflayer's instant
			// teleport_confirm is suppressed (PhysicsManager write interceptor) — the client's
			// own confirm, bridged below, is the one with correct timing. Remember the id so
			// detach() can confirm it if the client vanishes before acknowledging.
			if (meta.name === "position" && typeof data?.teleportId === "number") {
				this.pendingTeleportId = data.teleportId;
				this.lastServerTeleportAt = Date.now();
			}

			try {
				if (meta.name === "declare_commands") {

					// Decorate live updates too, otherwise switching dimensions
					// would wipe our literals from tab-completion.
					ClientCommands.decorateDeclareCommands(data);
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

			// The client acknowledged a live teleport — nothing pending for the failsafe.
			if (meta.name === "teleport_confirm") this.pendingTeleportId = null;

			// Drop movement until the replayed position has been confirmed.
			if (!movementAllowed && MOVEMENT_PACKETS_CS.has(meta.name)) return;

			// Track the wire state the player's own packets establish: position (so detach()
			// can save the pathfinding home and resume the simulation from where the server
			// actually is — bot.entity.position is frozen while the proxy is connected, see
			// PhysicsManager.tick), rotation, ground flag and sprint/sneak edges.
			if (MOVEMENT_PACKETS_CS.has(meta.name)) {
				if (typeof data?.x === "number" && typeof data?.y === "number" && typeof data?.z === "number") {
					this.lastClientPos = { x: data.x, y: data.y, z: data.z };
					this.lastClientMoveAt = Date.now();
				}
				if (typeof data?.yaw === "number" && typeof data?.pitch === "number") {
					this.clientYaw = data.yaw;
					this.clientPitch = data.pitch;
				}
				if (typeof data?.onGround === "boolean") this.clientOnGround = data.onGround;
			} else if (meta.name === "entity_action" && typeof data?.actionId === "number") {
				if (data.actionId === 3) this.clientSprint = true;
				else if (data.actionId === 4) this.clientSprint = false;
				else if (data.actionId === 0) this.clientSneak = true;
				else if (data.actionId === 1) this.clientSneak = false;
			}

			// Intercept commands. tryHandle is async but commands are local
			// so the latency is negligible; we await before forwarding the
			// fall-through case so unknown commands aren't dispatched twice.
			if (meta.name === "chat_command" || meta.name === "chat_command_signed" || meta.name === "chat" || meta.name === "tab_complete") {
				void ClientCommands.interceptClientPacket(this.client, this, data, meta).then(handled => {
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

		// ── Diagnostic: log packet rates and both ping numbers every 5s ──
		// "botPing" is the bot's RTT to 2b2t (what the user sees in tab).
		// "proxyPing" is the proxy server's RTT to the connected client.
		// "s2c"/"c2s" are bridged packets per second in each direction.
		// Disparity tells us where the bottleneck is: bot ping climbing means
		// our event loop can't keep up; proxy ping climbing means the client's
		// TCP socket is back-pressured.
		let s2cCount = 0;
		let c2sCount = 0;
		const s2cByName = new Map<string, number>();
		const onServerPacketCount = (_d: unknown, meta: PacketMeta) => {
			s2cCount++;
			s2cByName.set(meta.name, (s2cByName.get(meta.name) ?? 0) + 1);
		};
		const onClientPacketCount = () => { c2sCount++; };
		this.bot._client.on("packet", onServerPacketCount);
		this.client.on("packet", onClientPacketCount);
		const statsTimer = setInterval(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mineflayer typing gap
			const botPing: number = (this.bot._client as any).latency ?? -1;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minecraft-protocol typing gap
			const proxyPing: number = (this.client as any).latency ?? -1;
			const top = [ ...s2cByName.entries() ]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6)
				.map(([ n, c ]) => `${ n }=${ c / 5 | 0 }/s`)
				.join(" ");
			ServerClient.logger.log(`[stats] botPing=${ botPing }ms proxyPing=${ proxyPing }ms s2c=${ s2cCount / 5 | 0 }/s c2s=${ c2sCount / 5 | 0 }/s | top: ${ top }`);
			s2cCount = 0;
			c2sCount = 0;
			s2cByName.clear();
		}, 5000);
		this.disposers.push(() => clearInterval(statsTimer));
		this.disposers.push(() => this.bot._client.off("packet", onServerPacketCount));
		this.disposers.push(() => this.client.off("packet", onClientPacketCount));

		this.holograms = createHologram(
			this.client,
			this.bot,
			this.playerListCache as unknown as Map<string, never>,
			this.config.holograms.renderer
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
			renderer
		);
		this.holograms.attach();
		ServerClient.logger.log(`Hologram renderer swapped to ${ renderer }`);

		// Persist the choice.
		this.config.holograms.renderer = renderer;
		void prisma.client.update({
			where: { id: this.playerId },
			data: { config: this.config }
		}).catch(err => ServerClient.logger.warn("Failed to persist config:", err));
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

		// The client received a teleport but disconnected before confirming it. Mineflayer's
		// own confirm was suppressed for the session, so acknowledge it now or the server
		// kicks the bot's next movement packet for moving with a teleport pending.
		if (this.pendingTeleportId !== null) {
			try {
				MinecraftClient.physics.confirmTeleport(this.pendingTeleportId);
			} catch { /* upstream may already be gone */ }
			this.pendingTeleportId = null;
		}

		// Sprint/sneak always follow the client's own packets — the anticheat's view is
		// packet-derived, and a mismatch never self-heals (every tick mispredicts speed
		// forever). Synced unconditionally: even a session that only pearled and left must
		// hand these over.
		MinecraftClient.physics.syncWireActions(this.clientSprint, this.clientSneak);

		// Resume the bot's simulation position/rotation from the wire state the client
		// established — its own trackers froze at their pre-session values. Skipped when the
		// freshest truth is a server teleport (the forcedMove handler already synced from it)
		// or the client never moved (nothing changed).
		if (this.lastClientPos && this.lastClientMoveAt > this.lastServerTeleportAt) {
			MinecraftClient.physics.resumeFromProxy({
				x: this.lastClientPos.x,
				y: this.lastClientPos.y,
				z: this.lastClientPos.z,
				yaw: this.clientYaw,
				pitch: this.clientPitch,
				onGround: this.clientOnGround
			});
		}

		// Save the player's last known position as the new home so the bot
		// returns to where the player logged out. Prefer the tracked client
		// position (authoritative while proxy is connected) and fall back to
		// bot.entity.position if no movement packet was ever observed.
		const src = this.lastClientPos ?? this.bot.entity?.position ?? null;
		if (src && Number.isFinite(src.x) && Number.isFinite(src.y) && Number.isFinite(src.z)) {
			MinecraftClient.pathfinding.setHome({
				x: Math.floor(src.x) + 0.5,
				y: Math.floor(src.y),
				z: Math.floor(src.z) + 0.5
			});
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading stored field
		const originalUsername: string = (this.client as any)._originalUsername ?? this.client.username;
		ServerClient.logger.log(`${ originalUsername } lost connection: Disconnected`);
	}

}
