import { type Bot } from "mineflayer";
import { Movements, goals } from "mineflayer-pathfinder";

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
	const base = {
		x: Math.floor(home.x) + 0.5,
		y: Math.floor(home.y),
		z: Math.floor(home.z) + 0.5
	};

	const points = Array.from({ length: 2 }, () => {
		const ang = Math.random() * Math.PI * 2;
		const px = base.x + Math.cos(ang) * radius;
		const pz = base.z + Math.sin(ang) * radius;

		// snap targets to block centers to avoid edge weirdness
		return {
			x: Math.floor(px) + 0.5,
			y: base.y,
			z: Math.floor(pz) + 0.5
		};
	});

	try {
		for (const p of points) {

			// Use a small radius so we don't overfit exact coordinates (no digging)
			await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 0.5)).catch(() => {});
			await bot.waitForTicks(20);
		}

		// Return home
		await bot.pathfinder.goto(new goals.GoalNear(base.x, base.y, base.z, 0.5)).catch(() => {});
	} finally {

		// Always restore previous movements
		if (prevMovements) bot.pathfinder.setMovements(prevMovements);
	}
}
