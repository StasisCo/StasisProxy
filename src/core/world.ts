import chalk from "chalk";
import { type Bot } from "mineflayer";
import { Logger } from "../class/Logger";
import { formatHealth, formatHunger, printObject } from "../utils/format";

/**
 * Log information when the bot spawns in the world
 * @param bot The bot instance
 */
export default (bot: Bot) => bot.on("spawn", function() {

	Logger.log(`Spawned in the ${ chalk.cyan(bot.game.dimension) } at ${ chalk.yellow(bot.entity.position.floored()) }`);

	printObject({
		gameMode: bot.game.gameMode,
		health: formatHealth(bot.health),
		hunger: formatHunger(bot.food)
	});
	
}).emit("spawn");