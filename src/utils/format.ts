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

export function formatHunger(food: number) {
	food = Math.floor(food);
	return [ "🍗".repeat(food / 2), food % 2 === 1 ? "🍖" : "" ].join("");
}