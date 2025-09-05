import chalk from "chalk";
import { type Bot, type Dimension } from "mineflayer";
import { Logger } from "../class/Logger";
import { formatHealth, formatHunger, printObject } from "../utils/format";

export default function(bot: Bot) {

	let lastDimension: Dimension;

	function spawn() {

		if (lastDimension && lastDimension === bot.game.dimension) return Logger.log(`Teleported by server to ${ chalk.yellow(bot.player.entity.position) }`);
		lastDimension = bot.game.dimension;

		Logger.log(`Spawned in the ${ chalk.cyan(bot.game.dimension) } at ${ chalk.yellow(bot.entity.position.floored()) }`);
		printObject({
			gamemode: bot.game.gameMode,
			health: formatHealth(bot.health),
			hunger: formatHunger(bot.food, bot.foodSaturation)
		});

	}

	bot.on("spawn", spawn);
	spawn();

};