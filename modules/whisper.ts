import chalk from "chalk";
import { type Bot } from "mineflayer";
import { prisma } from "..";
import { Logger } from "../class/Logger";
import { StasisColumn } from "../class/StasisColumn";
import { StasisQueue } from "../class/StasisQueue";

export default (bot: Bot) => bot.on("whisper", async function(username, message) {

	// Get the player
	const player = Object.values(bot.players).find(e => e.username === username);
	if (!player || !player.uuid) return;

	Logger.log(`Stasis request received from ${ chalk.cyan(username) }`);

	// Make sure the player is not already queued
	if (StasisQueue.has(player.uuid)) {
		bot.chat(`/msg ${ username } You already have a pearl in queue, please wait...`);
		Logger.warn(`  ${ chalk.cyan(username) } is already queued, ignoring.`);
		return;
	}

	// Get all the active pearls in the database for this player
	const pearls = await prisma.stasis.findMany({
		where: {
			dimension: bot.game.dimension,
			owner: player.uuid,
			observer: bot.player.uuid,
			server: [ bot._client.socket.remoteAddress, bot._client.socket.remotePort ].filter(Boolean).join(":")
		}
	}).then(chambers => chambers.map(StasisColumn.from).filter(chamber => chamber !== null));

	const existing = pearls.filter(chamber => chamber.entities.length > 0);
	const orphaned = pearls.filter(chamber => chamber.entities.length === 0);

	// Cleanup orphaned pearls
	if (orphaned.length > 0) {
		Logger.warn(`  Removing ${ chalk.yellow(orphaned.length) } orphaned stasis...`);
		for (const orphan of orphaned) await orphan.remove();
	}

	// If they have no pearls, inform them and exit
	if (existing.length === 0) {
		bot.chat(`/msg ${ username } You have no pearls registered!`);
		return Logger.warn(`  Failed to locate a stasis for ${ chalk.cyan(username) }`);
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
	Logger.log(`  Queued stasis at ${ chalk.yellow(chamber.block.position) } for ${ chalk.cyan(username) }`);
	bot.chat(`/msg ${ username } Loading your pearl, please wait...`);

});