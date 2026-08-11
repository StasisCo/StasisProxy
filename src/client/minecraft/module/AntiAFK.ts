import z from "zod";
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";

const zConfigSchema = z.object({
	spinTimeout: z
		.number()
		.default(5_000)
		.describe("Start spinning the camera after this many ms of no movement"),
	swingTimeout: z
		.number()
		.default(300_000)
		.describe("Swing the arm after this many ms of no movement or swinging"),
	spinSpeed: z
		.number()
		.default(Math.PI / 20)
		.describe("Radians per tick (50 ms) when spinning")
});

export default class AntiAFK extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	private lastPosition = { x: 0, y: 0, z: 0 };
	private lastMoveTime = Date.now();
	private lastSwingTime = Date.now();
	private spinning = false;
	private interval: ReturnType<typeof setInterval> | null = null;

	/** Radians swept in the current direction, and which way we're sweeping. */
	private sweepAccum = 0;
	private sweepDir = -1;

	constructor() {
		super("AntiAFK");
	}

	public override onReady() {
		this.lastMoveTime = Date.now();
		this.lastSwingTime = Date.now();
		if (this.interval) clearInterval(this.interval);
		this.interval = setInterval(() => this.tick(), 1000);

		MinecraftClient.physics.onPreTick.push(() => this.preTick());
	}

	/** Called every 50 ms by PhysicsManager, before physics simulation */
	private preTick() {
		if (!this.spinning) return;
		if (MinecraftClient.proxy?.connected) return;

		const entity = MinecraftClient.bot.entity;
		if (!entity) return;

		// Sweep back and forth one full turn at a time instead of spinning endlessly in one
		// direction: the sent yaw is continuous (it never wraps, matching vanilla), so a
		// monotonic spin would grow it without bound and float32 precision on the wire value
		// degrades after enough accumulated revolutions.
		entity.yaw = (entity.yaw + this.sweepDir * this.config.spinSpeed) % (Math.PI * 2);
		this.sweepAccum += this.config.spinSpeed;
		if (this.sweepAccum >= Math.PI * 2) {
			this.sweepAccum = 0;
			this.sweepDir = -this.sweepDir;
		}
	}

	/** Called every 1 s to check idle timers */
	private tick() {
		const entity = MinecraftClient.bot.entity;
		if (!entity) return;

		const now = Date.now();
		const { x, y, z } = entity.position;
		const moved = x !== this.lastPosition.x || y !== this.lastPosition.y || z !== this.lastPosition.z;

		if (moved) {
			this.lastPosition = { x, y, z };
			this.lastMoveTime = now;
			this.lastSwingTime = now;

			if (this.spinning) this.spinning = false;
			return;
		}

		// Start spinning after 30 s of no movement
		if (!this.spinning && now - this.lastMoveTime >= this.config.spinTimeout) {
			this.spinning = true;
		}

		// Swing arm after 300 s of no movement or swinging
		if (now - this.lastSwingTime >= this.config.swingTimeout) {
			this.lastSwingTime = now;
			MinecraftClient.bot._client.write("arm_animation", { hand: 0 });
		}
	}

}