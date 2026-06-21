import mcData from "minecraft-data";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import z from "zod";
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";
import AutoEat from "./AutoEat";

const zConfigSchema = z.object({
	silentSwap: z
		.boolean()
		.default(true)
		.describe("Whether to swap to the sword silently (without changing the client's current hotbar slot)"),
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

	/** Last time we issued a mode=2 hotbar swap, debounced so we don't re-fire before the server confirms. */
	private timeOfLastSwap = 0;

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

		// Skip attacks while airborne — server treats those as critical hits
		// (fallDistance > 0 && !onGround), and crits cancel sweep entirely.
		if (!MinecraftClient.bot.entity.onGround) return;

		// Make sure a sword is in the hotbar
		const [ sword ] = this.getSwords(entity);
		if (!sword) return;

		const inv = MinecraftClient.bot.inventory;
		const { quickBarSlot } = MinecraftClient.bot;
		const isInHotbar = sword.slot >= inv.hotbarStart && sword.slot < inv.hotbarStart + 9;

		let slot: number;
		if (isInHotbar) {

			// Already in the hotbar — just switch to it. No window click,
			// no cursor involvement, nothing the server can desync on.
			slot = sword.slot - inv.hotbarStart;

		} else {

			// Bail if a previous swap left something on the cursor, or if
			// we issued a swap recently and the server hasn't confirmed it
			// yet (firing another click would race with the in-flight one).
			if (inv.selectedItem) return;
			if (Date.now() - this.timeOfLastSwap < 500) return;

			// Prefer an empty hotbar slot so the swap doesn't displace
			// anything important (totem, food, pickaxe). Fall back to the
			// current quickBarSlot only if every hotbar slot is occupied.
			let hotbarIndex = -1;
			for (let i = 0; i < 9; i++) {
				if (!inv.slots[inv.hotbarStart + i]) {
					hotbarIndex = i;
					break;
				}
			}
			if (hotbarIndex === -1) {
				hotbarIndex = quickBarSlot >= inv.hotbarStart && quickBarSlot < inv.hotbarStart + 9 ? quickBarSlot - inv.hotbarStart : 0;
			}

			// Single mode=2 (NUMBER_KEY) window_click — server atomically
			// exchanges the inventory slot with the chosen hotbar slot,
			// never picking the item up onto the cursor.
			void MinecraftClient.bot.clickWindow(sword.slot, hotbarIndex, 2);
			this.timeOfLastSwap = Date.now();

			// Skip this tick's attack — let the server confirm the swap
			// before we start swinging. Next tick the sword will be in the
			// hotbar and we'll take the fast path above.
			return;

		}
		
		// Save current rotation so we can restore it after the attack.
		const { pitch, yaw } = MinecraftClient.bot.entities[MinecraftClient.bot.entity.id] as Entity;

		// Aim at the target's eye-line (entity center + half height) — same
		// point the Java SwordAura aims at. Aiming at the foot (.position)
		// can produce a steep downward pitch on tall mobs that still hits
		// but reads as a "head-down" attack server-side.
		const aimY = entity.position.y + (entity.height ?? 1.8) * 0.5;
		const eye = MinecraftClient.bot.entity.position.offset(0, MinecraftClient.bot.entity.height, 0);
		const dx = entity.position.x - eye.x;
		const dy = aimY - eye.y;
		const dz = entity.position.z - eye.z;
		const xz = Math.sqrt(dx * dx + dz * dz);
		const aimYaw = Math.atan2(-dx, -dz);
		const aimPitch = Math.atan2(dy, xz);

		// Re-check onGround right before the synchronous attack burst — no
		// awaits below this line so it can't change underneath us.
		if (!MinecraftClient.bot.entity.onGround) return;

		// Silent swap to sword if we have one
		if (slot >= 0) MinecraftClient.bot.setQuickBarSlot(slot);

		// Sweeping-edge requires the server to see us as NOT sprinting at the
		const wasSprinting = MinecraftClient.bot.controlState.sprint;
		MinecraftClient.bot._client.write("entity_action", {
			entityId: MinecraftClient.bot.entity.id,
			actionId: 4, // STOP_SPRINTING
			jumpBoost: 0
		});
		if (wasSprinting) MinecraftClient.bot.controlState.sprint = false;

		// Send aim rotation immediately before the attack so the server has
		MinecraftClient.physics.sendLook(aimYaw, aimPitch);

		// Attack — bot.attack() writes use_entity then arm_animation in 1.20.1
		MinecraftClient.bot.attack(entity);
		this.timeOfLastSwing = Date.now();

		// Diagnostic: server-side sweep requires onGround && !sprinting && sword
		if (wasSprinting) {
			MinecraftClient.bot._client.write("entity_action", {
				entityId: MinecraftClient.bot.entity.id,
				actionId: 3, // START_SPRINTING
				jumpBoost: 0
			});
			MinecraftClient.bot.controlState.sprint = true;
		}

		// Hold the sword in mainhand for the next 3 ticks (~150ms) so the XP
		if (this.config.silentSwap) {
			this.holdTicksRemaining = 3;
			this.restoreSlot = quickBarSlot;
		}

		// Restore rotation
		MinecraftClient.bot.look(yaw, pitch, true);

	}

}
