import { Glob } from "bun";
import chalk from "chalk";
import { type Bot as BotType, type Player } from "mineflayer";
import z from "zod";
import { prisma } from "..";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { CHAT_COMMAND_PREFIX, DISABLE_CHAT_COMMANDS } from "../config";
import { formatPlayer, printObject } from "../utils/format";

const zModule = z.object({
	aliases: z.array(z.string()).min(1),
	default: z.function({
		input: z.tuple([
			z.custom<Player>(),
			z.array(z.string())
		]),
		output: z.promise(z.void())
	}),
	permission: z.enum([ "everyone", "whitelisted", "operator" ]).default("everyone")
});

/**
 * Module to handle chat commands for the bot
 * @param bot The bot instance
 */
export default async function(bot: BotType) {

	const commands: z.infer<typeof zModule>[] = [];
	
	// Load core modules and modules
	for await (const path of new Glob("src/{commands}/**/*.ts").scan()) {
		const module = await import(`../../${ path }`)
			.then(zModule.parseAsync);
		commands.push(module);
	}

	/**
	 * Handle commands from public chat with a specific prefix
	 */
	bot.on("chat", async function(username, message) {
		if (DISABLE_CHAT_COMMANDS) return;
		if (!message.startsWith(CHAT_COMMAND_PREFIX)) return;
		const command = message.substring(CHAT_COMMAND_PREFIX.length).split(" ")[0]?.toLowerCase();
		const args = message.split(" ").slice(1);
		const sender = bot.players[username];
		if (!sender || !sender.uuid || !command) return;
		exec(sender, command, args);
	});
	
	/**
	 * Handle commands from private messages (whispers)
	 */
	bot.on("whisper", async function(username, message) {
		const command = message.split(" ")[0]?.toLowerCase();
		const args = message.split(" ").slice(1);
		const sender = bot.players[username];
		if (!sender || !sender.uuid || !command) return;
		exec(sender, command, args);
	});

	/**
	 * Execute a command
	 * @param player - The player who sent the command
	 * @param cmd - The command to execute
	 * @param args - The arguments for the command
	 */
	async function exec(player: Player, cmd: string, args: string[]) {

		Logger.log("Command received:");
		printObject({
			from: formatPlayer(player),
			command: cmd,
			arguments: args.length > 0 ? args : chalk.gray("(none)")
		});

		const command = commands.find(c => c.aliases.includes(cmd));
		if (!command) return;

		// Check permissions
		switch (command.permission) {
			
			case "operator": {
				const isOp = await prisma.operator.count({ where: {
					bot: Bot.instance.player.uuid,
					server: Bot.server,
					uuid: player.uuid
				}}).then(c => c > 0);
				if (!isOp) return;
				break;
			}

			case "whitelisted": {
				const isOp = await prisma.operator.count({ where: {
					bot: Bot.instance.player.uuid,
					server: Bot.server,
					uuid: player.uuid
				}}).then(c => c > 0);
				if (isOp) break; // Operators are always allowed
				const isWhitelisted = await prisma.whitelist.count({ where: {
					bot: Bot.instance.player.uuid,
					server: Bot.server,
					uuid: player.uuid
				}}).then(c => c > 0);
				if (!isWhitelisted) return;
				break;
			}

		}

		// Execute the command
		await command.default(player, args);
		
		// switch (cmd.toLowerCase()) {

		// 	/**
		// 	 * Allow the bot to send a message in chat
		// 	 * @usage <...message|command>
		// 	 */
		// 	case "say":
		// 	case "sudo":
		// 		bot.chat(args.join(" "));
		// 		break;

		// 	// /**
		// 	//  * Add a player as an operator (Allows them to control the bot via chat commands)
		// 	//  * @usage <username>
		// 	//  * @permission op
		// 	//  */
		// 	// case "op": {
				
		// 	// 	const isOp = prisma.operator.count({ where: { uuid: player.uuid, server: Bot.server }}).then(c => c > 0);
		// 	// 	if (!isOp) {
		// 	// 		bot.chat(`/msg ${ player.username } You are not allowed to use that command!`);
		// 	// 		Logger.warn("Ignoring unauthorized op command:");
		// 	// 		printObject({ from: formatPlayer(player) });
		// 	// 		return;
		// 	// 	}

		// 	// 	const target = args[0];
		// 	// 	if (!target) {
		// 	// 		bot.chat(`/msg ${ player.username } Usage: ${ CHAT_COMMAND_PREFIX }op <username>`);
		// 	// 		break;
		// 	// 	}
		// 	// 	const targetPlayer = Object.values(bot.players).find(e => e.username === target);
		// 	// 	if (!targetPlayer || !targetPlayer.uuid) {
		// 	// 		bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
		// 	// 		break;
		// 	// 	}
		// 	// 	await prisma.operator.create({ data: { uuid: targetPlayer.uuid, server: Bot.server }});
		// 	// 	bot.chat(`/msg ${ player.username } Player ${ target } has been added as an operator!`);
		// 	// 	Logger.log(`Player ${ chalk.cyan(target) } has been added as an operator by ${ chalk.cyan(player.username) }`);
		// 	// 	break;
		// 	// }

		// 	// case "deop": {
		// 	// 	const isOp = prisma.operator.count({ where: { uuid: player.uuid, server: Bot.server }}).then(c => c > 0);
		// 	// 	if (!isOp) {
		// 	// 		bot.chat(`/msg ${ player.username } You are not allowed to use that command!`);
		// 	// 		Logger.warn("Ignoring unauthorized op command:");
		// 	// 		printObject({ from: formatPlayer(player) });
		// 	// 		return;
		// 	// 	}

		// 	// 	const target = args[0];
		// 	// 	if (!target) {
		// 	// 		bot.chat(`/msg ${ player.username } Usage: ${ CHAT_COMMAND_PREFIX }deop <username>`);
		// 	// 		break;
		// 	// 	}
		// 	// 	const targetPlayer = Object.values(bot.players).find(e => e.username === target);
		// 	// 	if (!targetPlayer || !targetPlayer.uuid) {
		// 	// 		bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
		// 	// 		break;
		// 	// 	}
		// 	// 	await prisma.operator.deleteMany({ where: { uuid: targetPlayer.uuid, server: Bot.server }});
		// 	// 	bot.chat(`/msg ${ player.username } Player ${ target } has been removed as an operator!`);
		// 	// 	Logger.log(`Player ${ chalk.cyan(target) } has been removed as an operator by ${ chalk.cyan(player.username) }`);
		// 	// 	break;
		// 	// }

		// 	// case "whitelist": {
				
		// 	// 	const subCommand = args.shift()?.toLowerCase();
		// 	// 	switch (subCommand) {

		// 	// 		case "add": {
				
		// 	// 			const isOp = prisma.whitelist.count({ where: { uuid: player.uuid, server: Bot.server }}).then(c => c > 0);
		// 	// 			if (!isOp) {
		// 	// 				bot.chat(`/msg ${ player.username } You are not allowed to use that command!`);
		// 	// 				Logger.warn("Ignoring unauthorized op command:");
		// 	// 				printObject({ from: formatPlayer(player) });
		// 	// 				return;
		// 	// 			}

		// 	// 			const target = args[0];
		// 	// 			if (!target) {
		// 	// 				bot.chat(`/msg ${ player.username } Usage: ${ CHAT_COMMAND_PREFIX }op <username>`);
		// 	// 				break;
		// 	// 			}
		// 	// 			const targetPlayer = Object.values(bot.players).find(e => e.username === target);
		// 	// 			if (!targetPlayer || !targetPlayer.uuid) {
		// 	// 				bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
		// 	// 				break;
		// 	// 			}
		// 	// 			await prisma.whitelist.create({ data: { uuid: targetPlayer.uuid, server: Bot.server }});
		// 	// 			bot.chat(`/msg ${ player.username } Player ${ target } has been added as an whitelist!`);
		// 	// 			Logger.log(`Player ${ chalk.cyan(target) } has been added to the whitelist by ${ chalk.cyan(player.username) }`);
		// 	// 			break;
		// 	// 		}

		// 	// 		case "rm": {
		// 	// 			const isOp = prisma.whitelist.count({ where: { uuid: player.uuid, server: Bot.server }}).then(c => c > 0);
		// 	// 			if (!isOp) {
		// 	// 				bot.chat(`/msg ${ player.username } You are not allowed to use that command!`);
		// 	// 				Logger.warn("Ignoring unauthorized op command:");
		// 	// 				printObject({ from: formatPlayer(player) });
		// 	// 				return;
		// 	// 			}

		// 	// 			const target = args[0];
		// 	// 			if (!target) {
		// 	// 				bot.chat(`/msg ${ player.username } Usage: ${ CHAT_COMMAND_PREFIX }deop <username>`);
		// 	// 				break;
		// 	// 			}
		// 	// 			const targetPlayer = Object.values(bot.players).find(e => e.username === target);
		// 	// 			if (!targetPlayer || !targetPlayer.uuid) {
		// 	// 				bot.chat(`/msg ${ player.username } Player ${ target } not found!`);
		// 	// 				break;
		// 	// 			}
		// 	// 			await prisma.whitelist.deleteMany({ where: { uuid: targetPlayer.uuid, server: Bot.server }});
		// 	// 			bot.chat(`/msg ${ player.username } Player ${ target } has been removed as an whitelist!`);
		// 	// 			Logger.log(`Player ${ chalk.cyan(target) } has been removed from the whitelist by ${ chalk.cyan(player.username) }`);
		// 	// 			break;
		// 	// 		}

		// 	// 	}

		// 	// 	break;
		// 	// }

		// }

		// bot.on("chat", (username, message) => void CommandDispatcher.fromChat(username, message));
		// bot.on("whisper", (username, message) => void CommandDispatcher.fromWhisper(username, message));

		// bot.on("chat", (username, message) => {

		// 	console.log("[CHAT]", chalk.cyan(username), ":", message);

		// });

		// bot.on("whisper", async function(username, message) {

		// 	// Get the player
		// 	const player = Object.values(bot.players).find(e => e.username === username);
		// 	if (!player || !player.uuid) return;

		// 	Logger.log(`Stasis request received from ${ chalk.cyan(username) }`);

		// 	// Make sure the player is not already queued
		// 	if (StasisQueue.has(player.uuid)) {
		// 		bot.chat(`/msg ${ username } You already have a pearl in queue, please wait...`);
		// 		Logger.warn(`${ chalk.cyan(username) } is already queued, ignoring.`);
		// 		return;
		// 	}

		// 	// Get all the active pearls in the database for this player
		// 	const existing = await Stasis.fetch(player);

		// 	// If they have no pearls, inform them and exit
		// 	if (existing.length === 0) {
		// 		bot.chat(`/msg ${ username } You have no pearls registered!`);
		// 		return Logger.warn(`Failed to locate a stasis for ${ chalk.cyan(username) }`);
		// 	}

		// 	// Locate the closest pearl
		// 	const chamber = existing
		// 		.map(chamber => ({
		// 			chamber,
		// 			distance: bot.entity.position.distanceTo(chamber.block.position)
		// 		}))
		// 		.sort((a, b) => a.distance - b.distance)[0]?.chamber;
		// 	if (!chamber) return;

		// 	StasisQueue.add(chamber);
		// 	Logger.log(`Queued stasis at ${ chalk.yellow(chamber.block.position) } for ${ chalk.cyan(username) }`);
		// 	bot.chat(`/msg ${ username } Loading your pearl, please wait...`);

	}
	
};