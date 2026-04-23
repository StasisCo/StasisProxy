import type { Item } from "prismarine-item";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

export default class AutoXP extends Module {

	private lastPosition = { x: 0, y: 0, z: 0 };
	private lastMoveTime = Date.now();

	private static readonly MINIMUM_DURABILITY = 0.7;

	/** When idle for this long, repair to 100% instead of MINIMUM_DURABILITY */
	private static readonly IDLE_THRESHOLD_MS = 10_000;

	private static readonly ARMOR_SLOTS = [ 5, 6, 7, 8 ];

	public isMending = false;

	private savedPitch = 0;

	constructor() {
		super("AutoXP");
	}

	private get bottles() {
		return Client.bot.inventory.slots.filter(item => item && item.name === "experience_bottle") as Item[];
	}

	private getLowestDurabilityItem(): Item | null {
		let lowestItem : Item | null = null;
		let lowestDurability = 1;
		for (const slot of AutoXP.ARMOR_SLOTS) {
			const item = Client.bot.inventory.slots[slot];
			if (!item || !item.durabilityUsed || !item.maxDurability) continue;
			const durability = 1 - item.durabilityUsed / item.maxDurability;
			if (durability < lowestDurability) {
				lowestDurability = durability;
				lowestItem = item;
			}
		}
		return lowestItem;
	}

	public override async onTick() {

		const entity = Client.bot.entity;
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
		const idle = now - this.lastMoveTime >= AutoXP.IDLE_THRESHOLD_MS;
		const threshold = idle ? 1 : AutoXP.MINIMUM_DURABILITY;
		if (durability >= threshold) {
			if (this.isMending) this.stopMending();
			return;
		}

		// Find a bottle already in the hotbar
		const bottle = this.bottles.find(b => Client.bot.inventory.hotbarStart <= b.slot && b.slot < Client.bot.inventory.hotbarStart + 9);

		if (!bottle) {

			// No XP bottles in hotbar — move one there and wait for next tick
			if (!this.isMending) {
				const anyBottle = this.bottles[0];
				if (anyBottle) {
					Client.bot.moveSlotItem(anyBottle.slot, Client.bot.inventory.hotbarStart);
				}
			}
			return;
		}

		if (!this.isMending) {
			this.savedPitch = Client.bot.entity.pitch;
			this.isMending = true;
		}

		// Force pitch down and send look to server BEFORE the throw packet
		Client.bot.entity.pitch = -Math.PI / 2;
		Client.physics.sendLook(Client.bot.entity.yaw, -Math.PI / 2);

		// Equip and throw the bottle
		Client.bot.equip(bottle, "hand");
		Client.bot.activateItem(false);

	}

	private stopMending() {
		this.isMending = false;
		Client.bot.entity.pitch = this.savedPitch;
	}

}
