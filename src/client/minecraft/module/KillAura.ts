import mcData from "minecraft-data";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import z from "zod";
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";
import AutoEat from "./AutoEat";

const zConfigSchema = z.object({
	reachRange: z
		.number()
		.default(3)
		.describe("Reach range for attacking entities"),
	list: z
		.string()
		.array()
		.describe("List of entity names to attack")
		.default([
			"mobType:hostile"
		])
});

export default class KillAura extends Module<typeof zConfigSchema> {
	
	public override readonly zConfigSchema = zConfigSchema;
	
	constructor() {
		super("KillAura");
	}

	private timeOfLastSwing = 0;

	/** Ticks remaining to keep the sword in mainhand after a swing (so XP orbs from the kill mend it instead of armor). */
	private holdTicksRemaining = 0;

	/** Hotbar slot to restore once {@link holdTicksRemaining} reaches zero, or null if nothing to restore. */
	private restoreSlot: number | null = null;

	/**
	 * List all available swords in an array, in order of most damage to least damage excluding swords under 20 durability
	 * 
	 */
	private getSwords(target?: Entity): Item[] {
		return MinecraftClient.bot.inventory.items()
			.filter(i => i.name.endsWith("_sword"))
			.filter(i => i.maxDurability - i.durabilityUsed >= 20)
			.sort((a, b) => this.estimateDealtDamage(b, target) - this.estimateDealtDamage(a, target));
	}

	private estimateDealtDamage(item: Item, target?: Entity) {

		const variantDamage = {
			wooden_sword: 1,
			stone_sword: 2,
			iron_sword: 3,
			golden_sword: 2,
			diamond_sword: 4,
			netherite_sword: 5
		};

		function normalizeEnch(lvl: number | undefined): number {
			if (!lvl) return 0;
			return (lvl * lvl + 1) / 2;
		}

		let damage = variantDamage[item.name as keyof typeof variantDamage] || 1;

		damage += normalizeEnch(item.enchants.find(e => e.name === "sharpness")?.lvl);

		if (target) switch (target.name) {

			case "spider":
			case "cave_spider":
			case "endermite":
			case "silverfish":
				damage += normalizeEnch(item.enchants.find(e => e.name === "bane_of_arthropods")?.lvl);
				break;

			case "zombie":
			case "skeleton":
			case "stray":
			case "husk":
			case "wither_skeleton":
			case "wither":
			case "drowned":
			case "zombified_piglin":
				damage += normalizeEnch(item.enchants.find(e => e.name === "smite")?.lvl);
				break;

		}

		return damage;

	}

	public override async onTickPre() {
		if (!MinecraftClient.bot.entity) return;

		// Hold the sword in mainhand for a few ticks after each swing so any XP
		// orbs spawned by the kill mend the sword instead of armor.
		if (this.holdTicksRemaining > 0) {
			this.holdTicksRemaining--;
			if (this.holdTicksRemaining === 0 && this.restoreSlot !== null) {
				MinecraftClient.bot.setQuickBarSlot(this.restoreSlot);
				this.restoreSlot = null;
			}
		}

		if (Date.now() - this.timeOfLastSwing <= 625) return;

		// Don't swap to a sword while AutoEat is feeding us — the swap would
		// interrupt the use_item action and cancel the eat.
		if (Module.get<AutoEat>("AutoEat").isEating) return;

		const [ entity ] = Object.values(MinecraftClient.bot.entities)
			.filter(e => e.id !== MinecraftClient.bot.entity.id)
			.filter(e => e.position.distanceSquared(MinecraftClient.bot.entity.position) <= this.config.reachRange ** 2)
			.sort((a, b) => a.position.distanceSquared(MinecraftClient.bot.entity.position) - b.position.distanceSquared(MinecraftClient.bot.entity.position))
			.filter(entity => {
				for (const filter of this.config.list) {

					if (!entity.name) continue;

					if (entity.name.toLowerCase().replace(/\s/g, "_") === filter.toLowerCase().replace(/\s/g, "_")) return true;

					const e = mcData(MinecraftClient.bot.version).entitiesByName[entity.name];
					if (!e) continue;

					if (e.category && filter.toLowerCase().replace(/\s/g, "_") === e.category.toLowerCase().replace(/\s/g, "_")) return true;

				}

				return false;
			});

		// Filter

		if (!entity) return;

		// Make sure a sword is in the hotbar
		const [ sword ] = this.getSwords(entity);
		if (!sword) return;

		let slot = sword.slot - 36;
		const { quickBarSlot } = MinecraftClient.bot;
		if (sword.slot < MinecraftClient.bot.inventory.hotbarStart || sword.slot >= MinecraftClient.bot.inventory.hotbarStart + 9) {

			// If not, swap it to the hotbar (preferably the current quick bar slot to minimize disruption)
			const targetSlot = quickBarSlot >= MinecraftClient.bot.inventory.hotbarStart && quickBarSlot < MinecraftClient.bot.inventory.hotbarStart + 9 ? quickBarSlot : MinecraftClient.bot.inventory.hotbarStart;
			MinecraftClient.bot.moveSlotItem(sword.slot, targetSlot);
			slot = targetSlot - 36;

		}
		
		// Save current rotation, then force-send target rotation before attack.
		const { pitch, yaw } = MinecraftClient.bot.entities[MinecraftClient.bot.entity.id] as Entity;
		await MinecraftClient.bot.lookAt(entity.position, true);
		MinecraftClient.physics.sendLook(entity.position);

		// Silent swap to sword if we have one
		if (slot >= 0) MinecraftClient.bot.setQuickBarSlot(slot);

		// Attack
		MinecraftClient.bot.swingArm("right");
		MinecraftClient.bot.attack(entity);
		this.timeOfLastSwing = Date.now();

		// Hold the sword in mainhand for the next 3 ticks (~150ms) so the XP
		// orbs from the kill mend the sword in preference to armor. The tick
		// counter at the top of onTickPre handles the deferred restore.
		this.holdTicksRemaining = 3;
		this.restoreSlot = quickBarSlot;

		// Restpre rtateion
		MinecraftClient.bot.look(yaw, pitch, true);

	}

}
