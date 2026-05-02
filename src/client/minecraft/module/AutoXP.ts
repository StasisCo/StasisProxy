import type { Item } from "prismarine-item";
import z from "zod";
import { Module } from "../Module";
import { MinecraftClient } from "../MinecraftClient";

const zConfigSchema = z.object({
	minDurability: z
		.number()
		.default(0.7)
		.describe("Start mending when armor durability falls below this fraction (0..1)"),
	idleThreshold: z
		.number()
		.default(10_000)
		.describe("After this many ms of no movement, repair to 100% instead of minDurability")
});

export default class AutoXP extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	private lastPosition = { x: 0, y: 0, z: 0 };
	private lastMoveTime = Date.now();

	public isMending = false;

	private savedPitch = 0;

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

	public override async onTickPre() {

		const entity = MinecraftClient.bot.entity;
		if (!entity) return;

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

		// Find a bottle already in the hotbar
		const bottle = this.bottles.find(b => MinecraftClient.bot.inventory.hotbarStart <= b.slot && b.slot < MinecraftClient.bot.inventory.hotbarStart + 9);

		if (!bottle) {

			// No XP bottles in hotbar — move one there and wait for next tick
			if (!this.isMending) {
				const anyBottle = this.bottles[0];
				if (anyBottle) {
					MinecraftClient.bot.moveSlotItem(anyBottle.slot, MinecraftClient.bot.inventory.hotbarStart);
				}
			}
			return;
		}

		if (!this.isMending) {
			this.savedPitch = MinecraftClient.bot.entity.pitch;
			this.isMending = true;
		}

		// Force pitch down and send look to server BEFORE the throw packet
		MinecraftClient.bot.entity.pitch = -Math.PI / 2;
		MinecraftClient.physics.sendLook(MinecraftClient.bot.entity.yaw, -Math.PI / 2);

		// Equip and throw the bottle
		MinecraftClient.bot.equip(bottle, "hand");
		MinecraftClient.bot.activateItem(false);

	}

	private stopMending() {
		this.isMending = false;
		MinecraftClient.bot.entity.pitch = this.savedPitch;
	}

}
