import chalk from "chalk";
import { type Bot } from "mineflayer";
import { Logger } from "../class/Logger";
import { formatHealth, formatHunger, printObject } from "../utils/format";

/**
 * Monitor and log the bot's health and hunger changes.
 * @param bot The bot instance
 */
export default function(bot: Bot) {
	
	let lastHealth: number = Math.floor(bot.health);
	let lastHunger: number = Math.floor(bot.food);

	bot.on("health", async function() {

		const health = Math.floor(bot.health);
		const food = Math.floor(bot.food);

		// If nothing changed, ignore
		if (lastHealth === health && lastHunger === food) return;
		
		if (lastHealth && health < lastHealth) {
			const diff = lastHealth - health;
			Logger.log(`Took ${ chalk.yellow(diff) } damage points`);
		} else if (lastHealth && health > lastHealth) {
			const diff = health - lastHealth;
			Logger.log(`Healed ${ chalk.yellow(diff) } health points`);
		} else if (lastHunger && food < lastHunger) {
			const diff = lastHunger - food;
			Logger.log(`Consumed ${ chalk.yellow(diff) } hunger points`);
		} else if (lastHunger && food > lastHunger) {
			const diff = food - lastHunger;
			Logger.log(`Gained ${ chalk.yellow(diff) } hunger points`);
		}
			
		lastHealth = health;
		lastHunger = food;

		printObject({
			health: formatHealth(bot.health),
			hunger: formatHunger(bot.food)
		});

	});

};