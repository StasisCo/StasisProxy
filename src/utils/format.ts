import chalk from "chalk";
import type { Player } from "mineflayer";
import { Vec3 } from "vec3";
import { Bot } from "../class/Bot";

Vec3.prototype.toString = function() {
	return `${ Intl.NumberFormat().format(this.x) } ${ chalk.gray("/") } ${ Intl.NumberFormat().format(this.y) } ${ chalk.gray("/") } ${ Intl.NumberFormat().format(this.z) }`;
};

export function printObject(obj: Record<string, unknown>) {
	const longestKey = Math.max(...Object.keys(obj).map(k => k.length));
	let index = 0;
	for (const [ k, v ] of Object.entries(obj).filter(([ , v ]) => v !== undefined && v !== null && v !== "" && v !== 0)) {
		const key = index === 0 ? ((index === Object.keys(obj).length - 1) ? "└── " : "├── ") : (index === Object.keys(obj).length - 1) ? "└── " : "├── ";
		console.log(`${ " ".repeat(25) } ${ chalk.gray(key) }${ chalk.blue(k.padEnd(longestKey)) } ${ chalk.gray("=") } ${ chalk[typeof v === "string" ? "cyan" : "yellow"](v) }`);
		index++;
	}
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

export function formatPlayer(playerId: string | Player) {
	const uuid = typeof playerId === "string" ? playerId : playerId.uuid;
	const player = Object.values(Bot.instance.players)
		.find(e => e.uuid === uuid || e.username === uuid);
	if (player) return `${ chalk.magenta(player.username) } ${ chalk.gray(`(${ chalk.cyan(player.uuid) })`) }`;
	return chalk.gray("Unknown player") + ` (${ chalk.gray(uuid) })`;
}