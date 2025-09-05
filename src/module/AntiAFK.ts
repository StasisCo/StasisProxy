import { Client } from "~/app/Client";
import { Module } from "~/class/Module";

const SPIN_TIMEOUT_MS = 5_000;
const SWING_TIMEOUT_MS = 300_000;

/** Radians per tick (50 ms) — one full rotation every ~6.3 seconds */
const SPIN_SPEED = Math.PI / 20;

export default class AntiAFK extends Module {

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

		entity.yaw = (entity.yaw - SPIN_SPEED) % (Math.PI * 2);
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
		if (!this.spinning && now - this.lastMoveTime >= SPIN_TIMEOUT_MS) {
			this.spinning = true;
		}

		// Swing arm after 300 s of no movement or swinging
		if (now - this.lastSwingTime >= SWING_TIMEOUT_MS) {
			this.lastSwingTime = now;
			Client.bot._client.write("arm_animation", { hand: 0 });
		}
	}

}