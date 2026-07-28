import type { PhysicsManager } from "./PhysicsManager";
import { MinecraftClient } from "../MinecraftClient";

const PI = Math.PI;
const TO_DEG = 180 / PI;

/**
 * Max absolute jitter (degrees) added to a silent rotation packet.
 * Small enough that the server's raycast still lands on the intended target,
 * large enough that two consecutive packets are never bit-identical — which
 * is the pattern Grim's duplicate-look detection keys on.
 */
const SILENT_JITTER = 0.04;

/** Don't bother sending when the server is already within this many degrees of the target. */
const SILENT_SKIP_TOLERANCE = 0.1;

function toNotchianYaw(yaw: number): number {
	return TO_DEG * (PI - yaw);
}

function toNotchianPitch(pitch: number): number {
	return TO_DEG * -pitch;
}

/** Wrap a degree delta into (-180, 180]. */
function wrapDegrees(degrees: number): number {
	let wrapped = degrees % 360;
	if (wrapped >= 180) wrapped -= 360;
	if (wrapped < -180) wrapped += 360;
	return wrapped;
}

function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

export interface LookAngles {

	/** Yaw in radians, mineflayer convention */
	yaw: number;

	/** Pitch in radians, mineflayer convention */
	pitch: number;

}

/**
 * Silent rotation dispatch.
 *
 * Action packets (`use_item`, `block_place`, `use_entity`) carry no rotation on 1.20.1 — the
 * server validates them against the last movement packet it received. Anything that needs the
 * server to believe we are looking somewhere must therefore put that rotation on the wire
 * *before* the action packet.
 *
 * A "silent" rotation is one extra `position_look` that repeats the last position we sent,
 * verbatim, carrying only a new yaw/pitch. Because the position is unchanged, Grim treats it as
 * a duplicate packet: it is neither counted toward Timer nor simulated as a movement tick. The
 * next physics tick's normal `position_look` carries the real rotation again, so nothing else
 * has to undo it.
 *
 * The duplicate exemption only exists for clients presenting below 1.21. We connect as 1.20.1,
 * so it is available — {@link PhysicsManager} warns on join if that ever stops being true.
 */
export class RotationManager {

	public constructor(private readonly physics: PhysicsManager) {}

	/** Physics tick counter, used to cap silent sends to one per tick. */
	private tick = 0;

	private lastSilentTick = -1;

	/** Last pre-jitter target we dispatched, for same-target de-duplication. */
	private lastTargetYaw = NaN;
	private lastTargetPitch = NaN;

	/** Called at the start of every physics tick. */
	public onTick() {
		this.tick++;
	}

	/** Reset per-connection state. */
	public reset() {
		this.tick = 0;
		this.lastSilentTick = -1;
		this.lastTargetYaw = NaN;
		this.lastTargetPitch = NaN;
	}

	/**
	 * The angles that aim the bot's eye at a world position.
	 * @param target Absolute world position to aim at
	 */
	public anglesTo(target: Vec3Like): LookAngles {
		const entity = this.physics.bot.entity;
		const eye = entity.position.offset(0, entity.height, 0);
		const dx = target.x - eye.x;
		const dy = target.y - eye.y;
		const dz = target.z - eye.z;
		const xz = Math.sqrt(dx * dx + dz * dz);
		return {
			yaw: Math.atan2(-dx, -dz),
			pitch: Math.atan2(dy, xz)
		};
	}

	/**
	 * Put a rotation aimed at `target` on the wire immediately, without moving the bot's real
	 * rotation. Call this in the same tick as — and immediately before — the action packet it
	 * is meant to validate.
	 * @returns whether a packet was actually sent
	 */
	public silentLookAt(target: Vec3Like): boolean {
		const { yaw, pitch } = this.anglesTo(target);
		return this.silent(yaw, pitch);
	}

	/**
	 * Put an explicit rotation on the wire immediately, without moving the bot's real rotation.
	 * @param yaw Yaw in radians, mineflayer convention
	 * @param pitch Pitch in radians, mineflayer convention
	 * @returns whether a packet was actually sent
	 */
	public silent(yaw: number, pitch: number): boolean {

		// A connected proxy client owns movement — injecting our own movement packets would
		// interleave with theirs and desync the server's view of where they are.
		if (MinecraftClient.proxy?.connected) return false;

		// Two silent packets in one tick is two duplicate positions in a row, which stops
		// looking like a client that simply hasn't moved.
		if (this.lastSilentTick === this.tick) return false;

		const last = this.physics.lastSent;

		const targetYaw = Math.fround(toNotchianYaw(yaw));
		const targetPitch = Math.fround(clamp(toNotchianPitch(pitch), -90, 90));

		// Skip when we already dispatched these angles AND the server still holds them (i.e.
		// the next normal movement packet hasn't restored the real rotation yet).
		if (!Number.isNaN(this.lastTargetYaw)
			&& Math.abs(wrapDegrees(targetYaw - this.lastTargetYaw)) < SILENT_SKIP_TOLERANCE
			&& Math.abs(targetPitch - this.lastTargetPitch) < SILENT_SKIP_TOLERANCE
			&& Math.abs(wrapDegrees(targetYaw - last.yaw)) < SILENT_SKIP_TOLERANCE
			&& Math.abs(targetPitch - last.pitch) < SILENT_SKIP_TOLERANCE) {
			return false;
		}

		const jitterYaw = (Math.random() - 0.5) * 2 * SILENT_JITTER;
		const jitterPitch = (Math.random() - 0.5) * 2 * SILENT_JITTER;

		// Express the yaw on the same revolution the server last saw. Minecraft accumulates yaw
		// unbounded, so a wrapped atan2 result can sit a full turn away from the last sent yaw —
		// a >320° delta in a single packet, which no real client produces.
		const sendYaw = Math.fround(this.continuousYaw(targetYaw) + jitterYaw);
		const sendPitch = Math.fround(clamp(targetPitch + jitterPitch, -90, 90));

		this.lastTargetYaw = targetYaw;
		this.lastTargetPitch = targetPitch;
		this.lastSilentTick = this.tick;

		this.physics.writeSilentLook(sendYaw, sendPitch);
		return true;

	}

	/** Express `target` (Notchian degrees) on the same revolution as the last yaw the server saw. */
	private continuousYaw(target: number): number {
		const anchor = this.physics.lastSent.yaw;
		return anchor + wrapDegrees(target - anchor);
	}

}
