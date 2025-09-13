import chalk from "chalk";
import type { Player } from "mineflayer";
import { prisma } from "..";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { COMMAND_CHAT_PREFIX } from "../config";

export const aliases = [ "op" ];

export const permission = "operator";

/**
 * Add or remove a player from the operator list
 */
export default async function(player: Player, args: string[]) {
	const bot = Bot.instance;
	const subcommand = args.shift()?.toLowerCase();
	switch (subcommand) {

		case "add": {

			const target = args[0];
			if (!target) {
				bot.chat(`/msg ${ player.username } Usage: ${ COMMAND_CHAT_PREFIX }op add <username>`);
				break;
			}
			const targetPlayer = Object.values(bot.players).find(e => e.username === target);
			if (!targetPlayer || !targetPlayer.uuid) {
				bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
				break;
			}
			await prisma.operator.create({ data: {
				uuid: targetPlayer.uuid,
				bot: Bot.instance.player.uuid,
				server: Bot.server
			}});
			bot.chat(`/msg ${ player.username } Player ${ target } has been added as an operator!`);
			Logger.log(`Player ${ chalk.cyan(target) } has been added as an operator by ${ chalk.cyan(player.username) }`);
			break;
		}

		case "rm": {

			const target = args[0];
			if (!target) {
				bot.chat(`/msg ${ player.username } Usage: ${ COMMAND_CHAT_PREFIX }op rm <username>`);
				break;
			}
			const targetPlayer = Object.values(bot.players).find(e => e.username === target);
			if (!targetPlayer || !targetPlayer.uuid) {
				bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
				break;
			}
			await prisma.operator.deleteMany({ where: {
				uuid: targetPlayer.uuid,
				bot: Bot.instance.player.uuid,
				server: Bot.server
			}});
			bot.chat(`/msg ${ player.username } Player ${ target } has been removed as an operator!`);
			Logger.log(`Player ${ chalk.cyan(target) } has been removed as an operator by ${ chalk.cyan(player.username) }`);
			break;
		}

	}

}