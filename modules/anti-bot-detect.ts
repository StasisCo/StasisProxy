import { type Bot } from "mineflayer";
import { goals } from "mineflayer-pathfinder";

export default async function(bot: Bot) {

	const position = bot.entity.position.clone();

	// 3 random points in a circle of radius 3
	const radius = 1;
	const points = Array.from({ length: 3 }, () => {
		const angle = Math.random() * Math.PI * 2;
		return position.offset(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
	});

	for (const point of points) {
		await bot.pathfinder.goto(new goals.GoalBlock(point.x, point.y, point.z));
		await bot.waitForTicks(20);
	}

	await bot.pathfinder.goto(new goals.GoalBlock(position.x, position.y, position.z));

}