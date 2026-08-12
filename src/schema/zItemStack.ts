import z from "zod";

/**
 * A single Minecraft item stack.
 *
 * Mirrors the data available from `net.minecraft.item.ItemStack` when
 * serialized to JSON for IRC transmission. Required fields are always
 * present; optional fields may be omitted when not applicable (e.g.
 * `damage`/`maxDamage` on unstackable items, `enchantments` when none).
 *
 * ```ts
 * {
 *   id:            "minecraft:diamond_pickaxe",  // registry ID
 *   count:         1,                             // stack size
 *   damage:        47,                            // current damage
 *   maxDamage:     1561,                          // max durability
 *   enchantments:  [{ id: "minecraft:efficiency", level: 5 }],
 *   name:          "Diamond Pickaxe",             // display / custom name
 *   nbt:           { ... }                        // extra NBT data
 * }
 * ```
 */
export const zItemStack = z.object({

	/** Minecraft registry ID — e.g. `"minecraft:diamond_pickaxe"`. */
	id: z.string(),

	/** Stack size (≥ 1). */
	count: z.number().int().positive(),

	/** Current damage dealt to the item (0 = undamaged). Only present for damageable items. */
	damage: z.number().int().nonnegative().optional(),

	/** Maximum damage the item can take before breaking. Only present for damageable items. */
	maxDamage: z.number().int().positive().optional(),

	/** Enchantments applied to the item. */
	enchantments: z.array(z.object({
		id: z.string(),
		level: z.number().int().positive()
	})).optional(),

	/** Display name (custom or translated). */
	name: z.string().optional(),

	/** Arbitrary extra NBT/component data as a JSON object. */
	nbt: z.record(z.string(), z.unknown()).optional()

});
