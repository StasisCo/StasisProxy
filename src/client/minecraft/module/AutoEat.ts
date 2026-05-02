import mcData from "minecraft-data";
import type { Item } from "prismarine-item";
import z from "zod";
import { Module } from "../Module";
import { MinecraftClient } from "../MinecraftClient";

const zConfigSchema = z.object({
	minHealth: z
		.number()
		.default(12)
		.describe("Minimum health (including absorption) before eating"),
	minHunger: z
		.number()
		.default(20)
		.describe("Minimum hunger before eating"),
	priority: z
		.enum([
			"effectiveQuality",
			"hungerSaturation",
			"saturation",
			"hunger"
		])
		.describe("Food selection priority when choosing what to eat")
		.default("effectiveQuality"),
	bannedFood: z
		.string()
		.array()
		.describe("List of food item names to never eat")
		.default([
			"rotten_flesh",
			"pufferfish",
			"chorus_fruit",
			"poisonous_potato",
			"spider_eye"
		])
});

export default class AutoEat extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	constructor() {
		super("AutoEat");
	}

	public absorption = 0;

	public health = MinecraftClient.bot.health;

	public hunger = MinecraftClient.bot.food;

	public saturation = MinecraftClient.bot.foodSaturation;

	/** The food item we are currently eating, or null if idle */
	private eating: Item | null = null;

	/** The slot the food was in when we started eating (to detect item changes) */
	private eatingSlot = -1;

	/** Whether we are currently eating */
	public get isEating(): boolean {
		return this.eating !== null;
	}

	/**
	 * Begin eating a food item. Equips it to main hand if needed, then sends
	 * the initial use_item packet. Subsequent ticks resend the packet to keep
	 * the server-side eating action alive.
	 */
	public async startEating(food: Item) {
		if (this.eating) return;

		this.eating = food;
		this.eatingSlot = food.slot;
		
		// Equip to main hand if not already held
		if (MinecraftClient.bot.heldItem?.slot !== food.slot) await MinecraftClient.bot.equip(food, "hand");

		// Send the initial use_item to begin eating
		this.sendUseItem();
	}

	/**
	 * Cancel the current eating action and tell the server to stop.
	 */
	public stopEating() {
		if (!this.eating) return;
		this.eating = null;
		this.eatingSlot = -1;

		MinecraftClient.bot.deactivateItem();
	}

	/** Send a use_item packet for the main hand */
	private sendUseItem() {
		MinecraftClient.bot.activateItem(false);
	}

	public override onPacketReceive({ name, data }: Packets.PacketEvent) {
		switch (name) {

			// Track absorption
			case "entity_metadata": {
				if (MinecraftClient.bot.entity.id !== data.entityId) return;
				for (const entry of data.metadata) {
					if (entry.key === 15) {
						this.absorption = entry.value as number;
						break;
					}
				}
				break;
			}

			// Eat completion + totem pops
			case "entity_status":
				if (MinecraftClient.bot.entity.id !== data.entityId) return;
				if (data.entityStatus === 9) {
					this.eating = null;
					this.eatingSlot = -1;
					MinecraftClient.bot.deactivateItem();
				}
				if (data.entityStatus === 35) {
					this.absorption = 8;
					this.health = 8;
				}
				break;

			// Track health/hunger/saturation
			case "update_health":
				this.hunger = data.food;
				this.saturation = data.foodSaturation;
				this.health = data.health;
				break;

		}

	}

	private getGap() {
		return MinecraftClient.bot.inventory.items()
			.filter(({ name }) => name === "enchanted_golden_apple")
			.sort((a, b) => {
				const aHotbar = a.slot >= MinecraftClient.bot.inventory.hotbarStart && a.slot < MinecraftClient.bot.inventory.hotbarStart + 9;
				const bHotbar = b.slot >= MinecraftClient.bot.inventory.hotbarStart && b.slot < MinecraftClient.bot.inventory.hotbarStart + 9;
				if (aHotbar && !bHotbar) return -1;
				if (!aHotbar && bHotbar) return 1;
				return b.count - a.count;
			})[0];
	}

	/** Find the best food item in inventory based on effective quality */
	private getBestFood() {
		const foods = mcData(MinecraftClient.bot.version).foodsByName;
		return MinecraftClient.bot.inventory.items()
			.filter(item => item.name in foods && !this.config.bannedFood.includes(item.name))
			.sort((a, b) => (foods[b.name]?.effectiveQuality ?? 0) - (foods[a.name]?.effectiveQuality ?? 0))[0];
	}

	public override onTickPre() {

		// If currently eating, resend use_item every tick to keep the action alive
		if (this.eating) {

			// Verify the food is still in hand
			const held = MinecraftClient.bot.heldItem;
			if (!held || held.slot !== this.eatingSlot) {
				this.stopEating();
			} else if (held.name === "enchanted_golden_apple" && this.absorption >= 16 && MinecraftClient.bot.entity.effects[10] !== undefined) {

				// Gapple would do nothing — already have max absorption and regeneration
				this.stopEating();
			} else {
				this.sendUseItem();
			}
			return;
		}

		// Gapple eat check
		const hasFireResistance = MinecraftClient.bot.entity.effects[12] !== undefined;
		const onFire = MinecraftClient.bot.entity.isValid && ((MinecraftClient.bot.entity.metadata[0] as unknown as number) & 0x01) !== 0;

		if ((this.health + this.absorption <= this.config.minHealth) || (onFire && !hasFireResistance)) {
			const food = this.getGap();
			if (food) {
				this.startEating(food);
				return;
			}
		}

		// Normal hunger eat check
		if (this.hunger < this.config.minHunger) {
			const food = this.getBestFood();
			if (food) {
				this.startEating(food);
				return;
			}
		}

	}

}
