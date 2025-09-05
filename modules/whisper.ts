import chalk from "chalk";
import { type Bot } from "mineflayer";
import { prisma } from "..";
import { Logger } from "../class/Logger";
import { StasisColumn } from "../class/StasisColumn";
import { StasisQueue } from "../class/StasisQueue";

export default (bot: Bot) => bot.on("whisper", async function(username, message) {

	// TODO: make it some kind of command syntax

	// Get the player
	const player = Object.values(bot.players).find(e => e.username === username);
	if (!player || !player.uuid) return;

	// Make sure the player is not already queued
	if (StasisQueue.isPlayerQueued(player.uuid)) {
		bot.chat(`/msg ${ username } You already have a pearl in queue, please wait...`);
		return Logger.warn(`${ chalk.cyan(username) } requested their pearl to be loaded, but they already have a pearl being loaded. ${ chalk.gray("(ignoring)") }`);
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
	for (const orphan of orphaned) {
		await prisma.stasis.deleteMany({ where: {
			x: orphan.block.position.x,
			y: orphan.block.position.y,
			z: orphan.block.position.z,
			observer: bot.player.uuid,
			dimension: bot.game.dimension,
			server: [ bot._client.socket.remoteAddress, bot._client.socket.remotePort ].filter(Boolean).join(":")
		}});
		Logger.warn(`${ chalk.cyan(player.username) } has an orphaned stasis at ${ chalk.yellow(orphan.block.position) }, it was removed from the database.`);
	}

	// If they have no pearls, inform them and exit
	if (existing.length === 0) {
		bot.chat(`/msg ${ username } You have no pearls registered!`);
		return Logger.warn(`${ chalk.cyan(username) } requested their pearl to be loaded, but they have no pearls registered. ${ chalk.gray("(ignoring)") }`);
	}

	// Locate the closest pearl
	const chamber = existing
		.map(chamber => ({
			chamber,
			distance: bot.entity.position.distanceTo(chamber.block.position)
		}))
		.sort((a, b) => a.distance - b.distance)[0]?.chamber;
	if (!chamber) return;

	Logger.log(`${ chalk.cyan(username) } requested their pearl to be loaded, queuing chamber at ${ chalk.yellow(chamber.block.position) }...`);
	StasisQueue.push(chamber);

	bot.chat(`/msg ${ username } Loading your pearl, please wait...`);

});