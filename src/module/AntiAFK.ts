import z from "zod";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

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

	constructor() {
		super("AntiAFK");
	}

	public override onReady() {
		this.lastMoveTime = Date.now();
		this.lastSwingTime = Date.now();
		if (this.interval) clearInterval(this.interval);
		this.interval = setInterval(() => this.tick(), 1000);

		Client.physics.onPreTick.push(() => this.preTick());
	}

	/** Called every 50 ms by PhysicsManager, before physics simulation */
	private preTick() {
		if (!this.spinning) return;
		if (Client.proxy?.connected) return;

		const entity = Client.bot.entity;
		if (!entity) return;

		entity.yaw = (entity.yaw - this.config.spinSpeed) % (Math.PI * 2);
	}

	/** Called every 1 s to check idle timers */
	private tick() {
		const entity = Client.bot.entity;
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
			Client.bot._client.write("arm_animation", { hand: 0 });
		}
	}

}