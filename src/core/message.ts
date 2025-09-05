import chalk from "chalk";
import { type Bot } from "mineflayer";
import { Logger } from "../class/Logger";
import { Stasis } from "../class/Stasis";
import { StasisQueue } from "../class/StasisQueue";

/**
 * Monitor and log the bot's health and hunger changes.
 * @param bot The bot instance
 */
export default (bot: Bot) => {

	bot.on("chat", async function(username, message) {
		console.log(username, message);
		if (username !== "TehPicix") return;
		if (message.startsWith("!resync")) return bot.chat("done syncing from postgres daddy");

	});

	// bot.on("chat", (username, message) => void CommandDispatcher.fromChat(username, message));
	// bot.on("whisper", (username, message) => void CommandDispatcher.fromWhisper(username, message));

	// bot.on("chat", (username, message) => {

	// 	console.log("[CHAT]", chalk.cyan(username), ":", message);

	// });

	bot.on("whisper", async function(username, message) {

		// Get the player
		const player = Object.values(bot.players).find(e => e.username === username);
		if (!player || !player.uuid) return;

		Logger.log(`Stasis request received from ${ chalk.cyan(username) }`);

		// Make sure the player is not already queued
		if (StasisQueue.has(player.uuid)) {
			bot.chat(`/msg ${ username } You already have a pearl in queue, please wait...`);
			Logger.warn(`${ chalk.cyan(username) } is already queued, ignoring.`);
			return;
		}

		// Get all the active pearls in the database for this player
		const existing = await Stasis.fetch(player);

		// If they have no pearls, inform them and exit
		if (existing.length === 0) {
			bot.chat(`/msg ${ username } You have no pearls registered!`);
			return Logger.warn(`Failed to locate a stasis for ${ chalk.cyan(username) }`);
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
		Logger.log(`Queued stasis at ${ chalk.yellow(chamber.block.position) } for ${ chalk.cyan(username) }`);
		bot.chat(`/msg ${ username } Loading your pearl, please wait...`);

	});
};