import chalk from "chalk";
import { type Bot, type Player } from "mineflayer";
import { Logger } from "../class/Logger";
import { Stasis } from "../class/Stasis";
import { StasisQueue } from "../class/StasisQueue";
import { CHAT_COMMAND_PREFIX } from "../config";
import { formatPlayer, printObject } from "../utils/format";

/**
 * Module to handle chat commands for the bot
 * @param bot The bot instance
 */
export default function(bot: Bot) {

	/**
	 * Handle commands from public chat with a specific prefix
	 */
	bot.on("chat", async function(username, message) {
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
		
		switch (cmd.toLowerCase()) {

			case "tp":
			case "teleport": {

				// Make sure the player is not already queued
				if (StasisQueue.has(player.uuid)) {
					bot.chat(`/msg ${ player.username } You already have a pearl in queue, please wait...`);
					Logger.warn("Ignoring duplicate stasis request:");
					printObject({
						from: formatPlayer(player)
					});
					return;
				}

				// Get all the active pearls in the database for this player
				const existing = await Stasis.fetch(player);

				// If they have no pearls, inform them and exit
				if (existing.length === 0) {
					bot.chat(`/msg ${ player.username } You have no pearls registered!`);
					Logger.warn("Failed to locate a stasis:");
					printObject({
						from: formatPlayer(player),
						reason: "No pearls found"
					});
					return;
				}

				// Locate the closest pearl
				const chamber = existing
					.map(chamber => ({
						chamber,
						distance: bot.entity.position.distanceTo(chamber.block.position)
					}))
					.sort((a, b) => a.distance - b.distance)[0]?.chamber;
				if (!chamber) return;

				StasisQueue.add(chamber);
				bot.chat(`/msg ${ player.username } Loading your pearl, please wait...`);

				break;
			}

		}

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