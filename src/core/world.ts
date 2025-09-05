import { type Bot } from "mineflayer";
import { Logger } from "../class/Logger";
import { formatHealth, formatHunger, printObject } from "../utils/format";

/**
 * Log information when the bot spawns in the world
 * @param bot The bot instance
 */
export default (bot: Bot) => bot.on("spawn", function() {
	Logger.log("Spawned in the world:");
	printObject({
		dimension: bot.game.dimension,
		gameMode: bot.game.gameMode,
		health: formatHealth(bot.health),
		hunger: formatHunger(bot.food),
		position: bot.entity.position.floored()
	});
}).emit("spawn");