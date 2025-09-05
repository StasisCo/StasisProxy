import { type Bot } from "mineflayer";
import { Movements, goals } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

/**
 * Make the bot walk around randomly for a few seconds after it initially spawns, to avoid being considered a bot by anti-bot measures.
 * @param bot The bot instance
 */
export default async function(bot: Bot) {
	const home = bot.entity.position.clone();

	// Build a temporary "no-dig" movement profile
	const prevMovements = bot.pathfinder.movements;
	const mov = new Movements(bot);

	// Hard guarantees: do not break/place to reach goals
	mov.canDig = false;
	mov.scafoldingBlocks = [];
	mov.allow1by1towers = false;
	mov.allowParkour = false;
	mov.allowFreeMotion = false;
	bot.pathfinder.setMovements(mov);

	// Generate 2 random ground points around the current block center (radius 1)
	const radius = 1;
	const base = home.floored().offset(0.5, 0, 0.5);

	// snap targets to block centers to avoid edge weirdness
	const points = Array.from({ length: 2 }, () => {
		const ang = Math.random() * Math.PI * 2;
		const px = base.x + Math.cos(ang) * radius;
		const pz = base.z + Math.sin(ang) * radius;
		return new Vec3(px, base.y, pz).floored().offset(0.5, 0, 0.5);
	});

	// Use a small radius so we don't overfit exact coordinates (no digging)
	for (const p of points) {
		await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 0.5)).catch(() => {});
		await bot.waitForTicks(20);
	}

	// Return home
	await bot.pathfinder.goto(new goals.GoalNear(base.x, base.y, base.z, 0.5)).catch(() => {});

	// Always restore previous movements
	if (prevMovements) bot.pathfinder.setMovements(prevMovements);

}
