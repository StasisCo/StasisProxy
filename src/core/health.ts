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
		
		// Banner
		(function() {

			// If health decreased
			if (lastHealth && health < lastHealth) {
				const diff = lastHealth - health;
				return Logger.log(`Took ${ chalk.yellow(diff) } damage points`);
			}

			// If health increased
			if (lastHealth && health > lastHealth) {
				const diff = health - lastHealth;
				return Logger.log(`Healed ${ chalk.yellow(diff) } health points`);
			}

			// If hunger decreased
			if (lastHunger && food < lastHunger) {
				const diff = lastHunger - food;
				return Logger.log(`Consumed ${ chalk.yellow(diff) } hunger points`);
			}

			// If hunger increased
			if (lastHunger && food > lastHunger) {
				const diff = food - lastHunger;
				return Logger.log(`Gained ${ chalk.yellow(diff) } hunger points`);
			}

		}());

		lastHealth = health;
		lastHunger = food;

		printObject({
			health: formatHealth(bot.health),
			hunger: formatHunger(bot.food)
		});

	});

};