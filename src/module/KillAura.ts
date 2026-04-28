import mcData from "minecraft-data";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import z from "zod";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

const zConfigSchema = z.object({
	reachRange: z
		.number()
		.default(3.5)
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

	/**
	 * List all available swords in an array, in order of most damage to least damage excluding swords under 20 durability
	 * 
	 */
	private getSwords(target?: Entity): Item[] {
		return Client.bot.inventory.items()
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
				damage += normalizeEnch(item.enchants.find(e => e.name === "bane_of_arthropods")?.lvl);
				break;

			case "zombie":
			case "skeleton":
			case "stray":
			case "husk":
			case "wither_skeleton":
			case "wither":
			case "drowned":
				damage += normalizeEnch(item.enchants.find(e => e.name === "smite")?.lvl);
				break;

		}

		return damage;

	}

	public override async onTickPre() {
		if (!Client.bot.entity) return;
		if (Date.now() - this.timeOfLastSwing <= 625) return;

		const [ entity ] = Object.values(Client.bot.entities)
			.filter(e => e.id !== Client.bot.entity.id)
			.filter(e => e.position.distanceSquared(Client.bot.entity.position) <= this.config.reachRange ** 2)
			.sort((a, b) => a.position.distanceSquared(Client.bot.entity.position) - b.position.distanceSquared(Client.bot.entity.position))
			.filter(entity => {
				for (const filter of this.config.list) {

					if (!entity.name) continue;

					if (entity.name.toLowerCase().replace(/\s/g, "_") === filter.toLowerCase().replace(/\s/g, "_")) return true;

					const e = mcData(Client.bot.version).entitiesByName[entity.name];
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
		const { quickBarSlot } = Client.bot;
		if (sword.slot < Client.bot.inventory.hotbarStart || sword.slot >= Client.bot.inventory.hotbarStart + 9) {

			// If not, swap it to the hotbar (preferably the current quick bar slot to minimize disruption)
			const targetSlot = quickBarSlot >= Client.bot.inventory.hotbarStart && quickBarSlot < Client.bot.inventory.hotbarStart + 9 ? quickBarSlot : Client.bot.inventory.hotbarStart;
			Client.bot.moveSlotItem(sword.slot, targetSlot);
			slot = targetSlot - 36;

		}
		
		// Save current rotation, then force-send target rotation before attack.
		const { pitch, yaw } = Client.bot.entities[Client.bot.entity.id] as Entity;
		await Client.bot.lookAt(entity.position, true);
		Client.physics.sendLook(entity.position);

		// Silent swap to sword if we have one
		if (slot >= 0) Client.bot.setQuickBarSlot(slot);

		// Attack
		Client.bot.swingArm("right");
		Client.bot.attack(entity);
		this.timeOfLastSwing = Date.now();

		// Restore swaps
		Client.bot.setQuickBarSlot(quickBarSlot);

		// Restpre rtateion
		Client.bot.look(yaw, pitch, true);

	}

}
