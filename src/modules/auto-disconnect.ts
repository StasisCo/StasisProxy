import chalk from "chalk";
import { type Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { HEALTH_BUFFER, TOTEM_BUFFER } from "../../config";
import { Logger } from "../class/Logger";

/**
 * Automatically disconnect the bot if health and totems are critically low.
 * @param bot The bot instance
 */
export default function(bot: Bot) {
	
	let lastHealth: number = Math.floor(bot.health);
	let lastHunger: number = Math.floor(bot.food);

	bot.on("health", async function() {

		const health = Math.floor(bot.health);
		const food = Math.floor(bot.food);

		const getTotems = () => bot.inventory.slots.filter(item => item && item.name === "totem_of_undying") as Item[];
	
		// Count the totems in the inventory
		const totems = getTotems().length;

		// If we have less totems then the totem gate AND health is low, eat a totem
		if (totems <= TOTEM_BUFFER && health <= HEALTH_BUFFER) {
			Logger.error(`Disconnecting... Only ${ chalk.yellow(health) } health and ${ chalk.yellow(totems) } totems`);
			bot.quit();
			process.exit(0);
		}

		lastHealth = health;
		lastHunger = food;

	});

};