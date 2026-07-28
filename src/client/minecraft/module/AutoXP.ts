import type { Item } from "prismarine-item";
import z from "zod";
import { Module } from "../Module";
import { MinecraftClient } from "../MinecraftClient";
import AutoEat from "./AutoEat";

const zConfigSchema = z.object({
	minDurability: z
		.number()
		.default(0.7)
		.describe("Start mending when armor durability falls below this fraction (0..1)"),
	idleThreshold: z
		.number()
		.default(10_000)
		.describe("After this many ms of no movement, repair to 100% instead of minDurability"),
	throwInterval: z
		.number()
		.default(1)
		.describe("Ticks between XP bottle throws")
});

export default class AutoXP extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	private lastPosition = { x: 0, y: 0, z: 0 };
	private lastMoveTime = Date.now();

	public isMending = false;

	/** Ticks until the next throw is allowed. */
	private cooldown = 0;

	constructor() {
		super("AutoXP");
	}

	private get bottles() {
		return MinecraftClient.bot.inventory.slots.filter(item => item && item.name === "experience_bottle") as Item[];
	}

	private getLowestDurabilityItem(): Item | null {
		let lowestItem : Item | null = null;
		let lowestDurability = 1;
		for (const slot of [ 5, 6, 8, 7 ]) {
			const item = MinecraftClient.bot.inventory.slots[slot];
			if (!item || !item.durabilityUsed || !item.maxDurability) continue;
			const durability = 1 - item.durabilityUsed / item.maxDurability;
			if (durability < lowestDurability) {
				lowestDurability = durability;
				lowestItem = item;
			}
		}
		return lowestItem;
	}

	public override onTickPre() {

		const entity = MinecraftClient.bot.entity;
		if (!entity) return;

		if (this.cooldown > 0) this.cooldown--;

		const now = Date.now();
		const { x, y, z } = entity.position;
		const moved = x !== this.lastPosition.x || y !== this.lastPosition.y || z !== this.lastPosition.z;

		if (moved) {
			this.lastPosition = { x, y, z };
			this.lastMoveTime = now;
		}

		if (this.bottles.length === 0) {
			if (this.isMending) this.stopMending();
			return;
		}

		const lowest = this.getLowestDurabilityItem();
		if (!lowest) {
			if (this.isMending) this.stopMending();
			return;
		}

		const durability = 1 - lowest.durabilityUsed! / lowest.maxDurability!;
		const idle = now - this.lastMoveTime >= this.config.idleThreshold;
		const threshold = idle ? 1 : this.config.minDurability;
		if (durability >= threshold) {
			if (this.isMending) this.stopMending();
			return;
		}

		// Eating owns the main hand and the item-use state — throwing a bottle would end the eat.
		if (Module.get<AutoEat>("AutoEat").isEating) return;

		// Find a bottle already in the hotbar
		const hotbarStart = MinecraftClient.bot.inventory.hotbarStart;
		const bottle = this.bottles.find(b => hotbarStart <= b.slot && b.slot < hotbarStart + 9);

		if (!bottle) {

			// No XP bottles in hotbar — swap one in and wait for the next tick.
			const anyBottle = this.bottles[0];
			if (anyBottle) {
				const click = MinecraftClient.interaction.stageIntoHotbar(anyBottle);
				if (click) void click.catch(() => { /* slot moved underneath us; retried next tick */ });
			}
			return;
		}

		this.isMending = true;

		if (this.cooldown > 0) return;

		// Hold the bottle before throwing it. Selecting a hotbar slot is a three-byte packet with
		// no container state behind it, and it lands before the use below.
		const hotbarIndex = bottle.slot - hotbarStart;
		if (MinecraftClient.bot.quickBarSlot !== hotbarIndex) {
			if (!MinecraftClient.interaction.setHotbarSlot(hotbarIndex)) return;
		}

		// The throw direction comes from whatever rotation the server last saw, so aim straight
		// down on the wire — without moving the bot's real rotation, which pathfinding owns.
		MinecraftClient.rotation.silent(MinecraftClient.bot.entity.yaw, -Math.PI / 2);

		// Only throw once the server is genuinely looking down: a silent send is skipped when the
		// angle is already there (fine) but also when something else owns the rotation this tick,
		// and a bottle thrown level lands somewhere useless.
		if (MinecraftClient.physics.lastSent.pitch < 80) return;

		// Throwing every tick is most of the interaction budget on its own, so hold back a couple
		// of slots for stasis activations and eating.
		if (MinecraftClient.interaction.useItem(false, 2)) this.cooldown = this.config.throwInterval;

	}

	private stopMending() {
		this.isMending = false;
		this.cooldown = 0;
	}

}
