import mcData from "minecraft-data";
import type { Item } from "prismarine-item";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

export default class AutoEat extends Module {

	private static readonly options = {
		minHealth: 12,
		minHunger: 20,
		priority: "effectiveQuality",
		bannedFood: [
			"rotten_flesh",
			"pufferfish",
			"chorus_fruit",
			"poisonous_potato",
			"spider_eye"
		]
	};

	public absorption = 0;

	public health = Client.bot.health;

	public hunger = Client.bot.food;

	public saturation = Client.bot.foodSaturation;

	/** The food item we are currently eating, or null if idle */
	private eating: Item | null = null;

	/** The slot the food was in when we started eating (to detect item changes) */
	private eatingSlot = -1;

	constructor() {
		super("AutoEat");
	}

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
		if (Client.bot.heldItem?.slot !== food.slot) await Client.bot.equip(food, "hand");

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

		Client.bot.deactivateItem();
	}

	/** Send a use_item packet for the main hand */
	private sendUseItem() {
		Client.bot.activateItem(false);
	}

	public override onPacket({ name, data }: Packets.PacketEvent) {
		switch (name) {

			// Track absorption
			case "entity_metadata": {
				if (Client.bot.entity.id !== data.entityId) return;
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
				if (Client.bot.entity.id !== data.entityId) return;
				if (data.entityStatus === 9) {
					this.eating = null;
					this.eatingSlot = -1;
					Client.bot.deactivateItem();
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
		return Client.bot.inventory.items()
			.filter(({ name }) => name === "enchanted_golden_apple")
			.sort((a, b) => {
				const aHotbar = a.slot >= Client.bot.inventory.hotbarStart && a.slot < Client.bot.inventory.hotbarStart + 9;
				const bHotbar = b.slot >= Client.bot.inventory.hotbarStart && b.slot < Client.bot.inventory.hotbarStart + 9;
				if (aHotbar && !bHotbar) return -1;
				if (!aHotbar && bHotbar) return 1;
				return b.count - a.count;
			})[0];
	}

	/** Find the best food item in inventory based on effective quality */
	private getBestFood() {
		const foods = mcData(Client.bot.version).foodsByName;
		return Client.bot.inventory.items()
			.filter(item => item.name in foods && !AutoEat.options.bannedFood.includes(item.name))
			.sort((a, b) => (foods[b.name]?.effectiveQuality ?? 0) - (foods[a.name]?.effectiveQuality ?? 0))[0];
	}

	public override onTick() {

		// If currently eating, resend use_item every tick to keep the action alive
		if (this.eating) {

			// Verify the food is still in hand
			const held = Client.bot.heldItem;
			if (!held || held.slot !== this.eatingSlot) {
				this.stopEating();
			} else if (held.name === "enchanted_golden_apple" && this.absorption >= 16 && Client.bot.entity.effects[10] !== undefined) {

				// Gapple would do nothing — already have max absorption and regeneration
				this.stopEating();
			} else {
				this.sendUseItem();
			}
			return;
		}

		// Gapple eat check
		const hasFireResistance = Client.bot.entity.effects[12] !== undefined;
		const onFire = Client.bot.entity.isValid && ((Client.bot.entity.metadata[0] as unknown as number) & 0x01) !== 0;

		if ((this.health + this.absorption <= AutoEat.options.minHealth) || (onFire && !hasFireResistance)) {
			const food = this.getGap();
			if (food) {
				this.startEating(food);
				return;
			}
		}

		// Normal hunger eat check
		if (this.hunger < AutoEat.options.minHunger) {
			const food = this.getBestFood();
			if (food) {
				this.startEating(food);
				return;
			}
		}

	}

}
