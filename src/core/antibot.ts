import mcDataLoader from "minecraft-data";
import { type Bot } from "mineflayer";
import { Movements, goals } from "mineflayer-pathfinder";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";

/**
 * Make the bot walk around randomly for a few seconds after it initially spawns, to avoid being considered a bot by anti-bot measures.
 * @param bot The bot instance
 */
export default async function(bot: Bot) {
	const home = bot.entity.position.clone();

	// Build a temporary "no-dig" movement profile
	const mcData = mcDataLoader(bot.version);
	const prevMovements = bot.pathfinder.movements;
	const mov = new Movements(bot);

	// Hard guarantees: do not break/place to reach goals
	mov.canDig = false;
	mov.scafoldingBlocks = [];
	mov.allow1by1towers = false;
	mov.allowParkour = false;
	mov.allowSprinting = false;
	mov.canOpenDoors = false;
	mov.allowFreeMotion = false; // disable free-fly in fluids
	mov.infiniteLiquidDropdownDistance = false;

	// Absolutely forbid liquids
	if ("liquidCost" in mov) mov.liquidCost = Infinity;

	// 2) Explicitly avoid known liquid/bubble vegetation blocks
	const avoidIds = [ "water", "flowing_water", "bubble_column", "kelp", "seagrass", "tall_seagrass" ]
		.map(n => mcData.blocksByName[n]?.id)
		.filter((x): x is number => typeof x === "number");

	// Some versions expose a Set you can extend:
	if (mov.blocksToAvoid instanceof Set) {
		for (const id of avoidIds) mov.blocksToAvoid.add(id);
	}

	// 3) Best-effort hard block: treat any target/stand position
	//    that is liquid as invalid (if your Movements impl supports it)
	if ("isLiquid" in mov && typeof mov.isLiquid === "function") {
		const origIsLiquid = mov.isLiquid.bind(mov);
		mov.isLiquid = (block: Block) => {
			if (block && avoidIds.includes(block.type)) return true;
			return origIsLiquid(block);
		};
	}

	// Apply the profile
	bot.pathfinder.setMovements(mov);

	// Generate 2 random ground points around the current block center (radius 1)
	const radius = 1;
	const base = home.floored().offset(0.5, 0, 0.5);

	// snap targets to block centers to avoid edge weirdness
	const points = Array.from({ length: 5 }, () => {
		const ang = Math.random() * Math.PI * 2;
		const px = base.x + Math.cos(ang) * radius;
		const pz = base.z + Math.sin(ang) * radius;
		return new Vec3(px, base.y, pz).floored().offset(0.5, 0, 0.5);
	});

	// Use a small radius so we don't overfit exact coordinates (no digging)
	for (const point of points) {
		await bot.pathfinder.goto(new goals.GoalNear(point.x, point.y, point.z, 0.5)).catch(() => {});
		await bot.waitForTicks(5);
		bot.setControlState("sneak", true);
		await bot.waitForTicks(5);
		bot.setControlState("sneak", false);
		await bot.waitForTicks(10);
		bot.setControlState("jump", true);
	}

	// Return home
	await bot.pathfinder.goto(new goals.GoalNear(base.x, base.y, base.z, 0.5)).catch(() => {});

	// Always restore previous movements
	if (prevMovements) bot.pathfinder.setMovements(prevMovements);

	bot.setControlState("jump", false);
	bot.setControlState("sneak", false);

}
