import chalk from "chalk";
import type { Player } from "mineflayer";
import { prisma } from "..";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { CHAT_COMMAND_PREFIX } from "../config";

export const aliases = [ "whitelist" ];

export const permission = "operator";

/**
 * Add or remove a player from the whitelist
 */
export default async function(player: Player, args: string[]) {
	const bot = Bot.instance;
	const subcommand = args.shift()?.toLowerCase();
	switch (subcommand) {

		case "add": {

			const target = args[0];
			if (!target) {
				bot.chat(`/msg ${ player.username } Usage: ${ CHAT_COMMAND_PREFIX }whitelist add <username>`);
				break;
			}
			const targetPlayer = Object.values(bot.players).find(e => e.username === target);
			if (!targetPlayer || !targetPlayer.uuid) {
				bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
				break;
			}
			await prisma.whitelist.create({ data: { uuid: targetPlayer.uuid, server: Bot.server }});
			bot.chat(`/msg ${ player.username } Player ${ target } has been added as an whitelist!`);
			Logger.log(`Player ${ chalk.cyan(target) } has been added to the whitelist by ${ chalk.cyan(player.username) }`);
			break;
		}

		case "rm": {

			const target = args[0];
			if (!target) {
				bot.chat(`/msg ${ player.username } Usage: ${ CHAT_COMMAND_PREFIX }whitelist rm <username>`);
				break;
			}
			const targetPlayer = Object.values(bot.players).find(e => e.username === target);
			if (!targetPlayer || !targetPlayer.uuid) {
				bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
				break;
			}
			await prisma.whitelist.deleteMany({ where: { uuid: targetPlayer.uuid, server: Bot.server }});
			bot.chat(`/msg ${ player.username } Player ${ target } has been removed as an whitelist!`);
			Logger.log(`Player ${ chalk.cyan(target) } has been removed from the whitelist by ${ chalk.cyan(player.username) }`);
			break;
		}

	}

}