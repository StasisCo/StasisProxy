import chalk from "chalk";
import { Logger } from "../class/Logger";

export function printObject(obj: Record<string, unknown>, indent = 2) {
	Object.entries(obj)
		.filter(([ , v ]) => v !== undefined && v !== null && v !== "" && v !== 0)
		.forEach(([ k, v ]) => Logger.log(`  ${ chalk.blue(k) }=${ chalk[typeof v === "string" ? "cyan" : "yellow"](v) }`));
}

export function formatHealth(health: number, maxHealth = 20) {
	health = Math.floor(health);
	return [
		"❤️ ".repeat(Math.floor(health / 2)),
		health % 2 === 1 ? "❤️‍🩹" : "",
		"🖤".repeat(maxHealth / 2 - Math.ceil(health / 2))
	].join("");
}

export function formatHunger(food: number, foodSaturation = 0) {
	const bar = [
		"🍗".repeat(Math.floor(food / 2)),
		food % 2 === 1 ? "🍖" : "",
		"◼️ ".repeat(10 - Math.ceil(food / 2))
	].join("");

	let count = 0;
	let formattedBar = "";
	for (const char of bar) {
		if (char === "🍗" || char === "🍖") {
			count++;
			if (count <= foodSaturation) {
				formattedBar += chalk.underline(char);
			} else {
				formattedBar += char;
			}
		} else {
			formattedBar += char;
		}
	}
	return formattedBar;

}