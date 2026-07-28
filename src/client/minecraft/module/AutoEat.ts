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

/** Ticks to wait for the server to confirm an eat before giving up on it. */
const CONFIRM_TIMEOUT_TICKS = 20;

/** Ticks to wait after a failed attempt before trying again. */
const RETRY_COOLDOWN_TICKS = 40;

export default class AutoEat extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	constructor() {
		super("AutoEat");
	}

	public absorption = 0;

	public health = MinecraftClient.bot.health;

	public hunger = MinecraftClient.bot.food;

	public saturation = MinecraftClient.bot.foodSaturation;

	/** Name of the food we are currently eating, or null if idle. */
	private eating: string | null = null;

	/** Hotbar index the food is held in for the current eat. */
	private eatingSlot = -1;

	/** Ticks since we put the `use_item` on the wire, for the confirmation timeout. */
	private ticksSinceStart = 0;

	/** Whether the server has acknowledged the current eat by reporting the use itself. */
	private confirmed = false;

	/** Ticks left before we may attempt another eat after a failure. */
	private cooldown = 0;

	/** Whether we were on fire last tick, so catching fire can be detected as an edge. */
	private lastBurning = false;

	/** Whether we are currently eating */
	public get isEating(): boolean {
		return this.eating !== null;
	}

	/**
	 * Begin eating a food item.
	 *
	 * A real client sends exactly one `use_item` and then holds the key down — the server keeps
	 * the use alive on its own and ignores a second start. This only ever sends one; everything
	 * afterwards is verification, not repetition.
	 *
	 * @param food The food item to eat
	 * @returns whether the eat was started
	 */
	private startEating(food: Item): boolean {
		if (this.eating) return false;

		const inventory = MinecraftClient.bot.inventory;
		const hotbarIndex = food.slot - inventory.hotbarStart;

		// Only eat from the hotbar. Pulling food in from the main inventory needs a container
		// click, which has to complete before the use is meaningful — so that is a separate
		// operation with its own tick, handled by the caller.
		if (hotbarIndex < 0 || hotbarIndex > 8) return false;

		if (MinecraftClient.bot.quickBarSlot !== hotbarIndex) {
			if (!MinecraftClient.interaction.setHotbarSlot(hotbarIndex)) return false;
		}

		if (!MinecraftClient.interaction.useItem()) return false;

		MinecraftClient.physics.beginItemUse();
		this.eating = food.name;
		this.eatingSlot = hotbarIndex;
		this.ticksSinceStart = 0;
		this.confirmed = false;
		return true;
	}

	/**
	 * Cancel the current eating action.
	 * @param release Whether to tell the server to stop. Only meaningful when the server thinks
	 *                we are using something — a release with no matching start is not a packet a
	 *                real client produces.
	 */
	public stopEating(release = true) {
		if (!this.eating) return;
		this.eating = null;
		this.eatingSlot = -1;
		this.ticksSinceStart = 0;
		this.confirmed = false;

		if (release && MinecraftClient.physics.serverUsingItem) MinecraftClient.interaction.releaseUseItem();
		MinecraftClient.physics.endItemUse();
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

					// The server finished (or interrupted) the use — PhysicsManager has already
					// cleared its own item-use state off the same packet, so no release is owed.
					this.eating = null;
					this.eatingSlot = -1;
					this.ticksSinceStart = 0;
					this.confirmed = false;
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

	private isInHotbar(item: Item): boolean {
		const start = MinecraftClient.bot.inventory.hotbarStart;
		return item.slot >= start && item.slot < start + 9;
	}

	/** Bring a food item into the hotbar so it can be eaten next tick. */
	private stageIntoHotbar(food: Item) {
		const click = MinecraftClient.interaction.stageIntoHotbar(food);
		if (click) void click.catch(() => { /* slot moved underneath us; retried next tick */ });
	}

	public override onTickPre() {

		if (this.cooldown > 0) this.cooldown--;

		// Catching fire is an event, not a state. Reading it as a state means that every time a
		// gapple finishes we are still burning, so we immediately start another — item-use speed
		// never lifts and the bot crawls for as long as it is on fire. Consume the edge on every
		// path, including the ones that return early.
		const onFire = MinecraftClient.bot.entity.isValid && ((MinecraftClient.bot.entity.metadata[0] as unknown as number) & 0x01) !== 0;
		const startedBurning = onFire && !this.lastBurning;
		this.lastBurning = onFire;

		// If currently eating, verify rather than repeat.
		if (this.eating) {
			this.ticksSinceStart++;

			const held = MinecraftClient.bot.heldItem;

			// Something took the food out of our hand — the server has already ended the use.
			if (!held || held.name !== this.eating || MinecraftClient.bot.quickBarSlot !== this.eatingSlot) {
				this.stopEating(false);
				this.cooldown = RETRY_COOLDOWN_TICKS;
				return;
			}

			// Gapple would do nothing — already have max absorption and regeneration.
			if (held.name === "enchanted_golden_apple" && this.absorption >= 16 && MinecraftClient.bot.entity.effects[10] !== undefined) {
				this.stopEating();
				return;
			}

			if (MinecraftClient.physics.serverUsingItem) {
				this.confirmed = true;
				return;
			}

			// The server had the use and no longer does — it finished, or something interrupted
			// it. Either way the eat is over and there is nothing to release.
			if (this.confirmed) {
				this.stopEating(false);
				return;
			}

			// The server never picked the use up at all. Repeating `use_item` would not help —
			// it ignores a start while already using, and if it isn't using then something
			// rejected the first one. Back off and let the next attempt start cleanly, rather
			// than sitting at eating speed forever while never actually being fed.
			if (this.ticksSinceStart >= CONFIRM_TIMEOUT_TICKS) {
				AutoEat.warnUnconfirmed();
				this.stopEating(false);
				this.cooldown = RETRY_COOLDOWN_TICKS;
			}

			return;
		}

		if (this.cooldown > 0) return;

		// Gapple eat check
		const hasFireResistance = MinecraftClient.bot.entity.effects[12] !== undefined;

		if ((this.health + this.absorption <= this.config.minHealth) || (startedBurning && !hasFireResistance)) {
			const food = this.getGap();
			if (food) {
				if (this.isInHotbar(food)) this.startEating(food);
				else this.stageIntoHotbar(food);
				return;
			}
		}

		// Normal hunger eat check
		if (this.hunger < this.config.minHunger) {
			const food = this.getBestFood();
			if (food) {
				if (this.isInHotbar(food)) this.startEating(food);
				else this.stageIntoHotbar(food);
			}
		}

	}

	/** Rate-limited warning so a persistently rejected eat doesn't flood the log. */
	private static lastWarn = 0;
	private static warnUnconfirmed() {
		const now = Date.now();
		if (now - AutoEat.lastWarn < 30_000) return;
		AutoEat.lastWarn = now;
		MinecraftClient.logger.warn("Started eating but the server never confirmed the item use — backing off");
	}

}
