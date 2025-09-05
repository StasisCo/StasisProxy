import mcDataLoader from "minecraft-data";
import { type Bot } from "mineflayer";
import { type Item } from "prismarine-item";
import { FOOD_BUFFER } from "../../config";

export default function(bot: Bot) {

	const mcData = mcDataLoader(bot.version);

	let isEating = false;
	let nextCheckTick = 0;

	const foodsTable: Record<number, { foodPoints?: number; saturation?: number }> = mcData.foods ?? {};

	function edible(item: Item | null | undefined): item is Item {
		return !!item && item.type in foodsTable;
	}

	function getFoodItems(): Item[] {
		return (bot.inventory.slots as (Item | null | undefined)[]).filter(edible) as Item[];
	}

	function chooseFood(need: number, items: Item[]): Item | null {

		// Prefer items that fit the need; score by foodPoints + saturation with small penalty if it overfills
		let best: Item | null = null;
		let bestScore = -Infinity;
		for (const it of items) {
			const meta = foodsTable[it.type] || {};
			const points = meta.foodPoints ?? 0;
			const sat = meta.saturation ?? 0;
			const over = Math.max(0, points - need);
			const score = points * 2 + sat - over * 3;
			if (score > bestScore) {
				bestScore = score;
				best = it;
			}
		}
		return best;
	}

	async function tryEat() {
		if (isEating) return;
		if (bot.food === undefined) return; // health plugin not ready yet
		if (bot.food >= FOOD_BUFFER) return; // already full enough
		const now = bot.time?.age ?? 0;
		if (now < nextCheckTick) return; // throttle checks

		const foods = getFoodItems();
		if (!foods.length) return;

		const need = Math.max(1, 20 - bot.food);
		const chosen = chooseFood(need, foods);
		if (!chosen) return;

		isEating = true;
		const prevHeld = bot.heldItem ?? null;

		try {

			// Don’t interfere with offhand (totem stays); equip food to main hand
			await bot.equip(chosen, "hand").catch(() => {});

			// Start eating
			const startFood = bot.food;
			bot.activateItem(); // begin use (eat/drink)

			// Wait until hunger increases OR ~40 ticks (~2s) timeout
			let ticks = 0;
			while (ticks < 40) {
				await bot.waitForTicks(1);
				ticks++;
				if (bot.food > startFood) break;
			}

			// Stop using item (safe even if finished)
			try {
				bot.deactivateItem();
			} catch {}

		} finally {

			// Restore previously held item (best effort)
			if (prevHeld) {
				try {
					await bot.equip(prevHeld, "hand");
				} catch {}
			}
			isEating = false;
			nextCheckTick = (bot.time?.age ?? 0) + 10; // small cool-down
		}
	}

	// run on every physics tick, same as your autototem
	bot.on("physicsTick", tryEat);

};
    