import chalk from "chalk";
import { type Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { HEALTH_BUFFER, TOTEM_BUFFER } from "../../config";
import { Logger } from "../class/Logger";
import { formatHealth, formatHunger, printObject } from "../utils/format";

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
			hunger: formatHunger(bot.food, bot.foodSaturation)
		});

	});

};