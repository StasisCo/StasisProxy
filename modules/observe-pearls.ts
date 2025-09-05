import chalk from "chalk";
import { omit } from "lodash";
import { type Bot } from "mineflayer";
import { prisma } from "..";
import { Logger } from "../class/Logger";
import { StasisColumn } from "../class/StasisColumn";
import { StasisQueue } from "../class/StasisQueue";
import { MAX_PLAYER_PEARLS } from "../config";

export default (bot: Bot) => bot.on("entitySpawn", async function(entity) {

	// Make sure its an ender pearl
	if (!entity.uuid || entity.type !== "projectile" || entity.name !== "ender_pearl") return;

	// Determine who threw the pearl
	const player = Object.values(bot.players)
		.filter(e => e.uuid !== bot.player.uuid)
		.filter(e => e.entity?.position.distanceTo(entity.position) <= 2)
		.sort((a, b) => a.entity.position.distanceTo(entity.position) - b.entity.position.distanceTo(entity.position))[0];
	if (!player || !player.uuid) return;

	// Get the pearls blockPosition
	const blockPos = bot.blockAt(entity.position);
	if (!blockPos) return;

	// Get the chamber from the block position
	const chamber = StasisColumn.from(blockPos.position, player.uuid);
	if (!chamber) return;

	Logger.log(`${ chalk.cyan(player.username) } threw a pearl in the stasis at ${ chalk.yellow(chamber.block.position) }`);

	// Make sure theres not already a different pearl in this chamber
	const occupants = chamber.entities.filter(e => e.uuid !== entity.uuid);
	if (occupants.length > 0) return Logger.warn("  This stasis is already occupied, ignoring...");

	// Clear any existing pearl data for this chamber
	await prisma.stasis.deleteMany({ where: omit(chamber.toJSON(), "owner", "id", "createdAt") });
		
	// Wait for the pearl to settle at the trapdoor
	await new Promise<void>(function loop(resolve) {
		const distance = entity.position.distanceTo(chamber.block.position);
		if (distance <= Math.SQRT2 && entity.velocity.abs().x <= 0.1 && entity.velocity.abs().y <= 0.1 && entity.velocity.abs().z <= 0.1) return resolve();
		bot.waitForTicks(1).then(() => loop(resolve));
	});

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

	// If they have too many, remove this pearl and ignore it
	if (existing.length >= MAX_PLAYER_PEARLS) {
		bot.chat(`/msg ${ player.username } You already have ${ existing.length } / ${ MAX_PLAYER_PEARLS } pearls registered. Extra pearls will be removed!`);
		Logger.warn(`  ${ chalk.cyan(player.username) } already has ${ chalk.yellow(existing.length) } / ${ chalk.yellow(MAX_PLAYER_PEARLS) } stasis, this pearl will be removed...`);
		StasisQueue.add(chamber);
		return;
	}

	// include the new pearl being added
	existing.push(chamber);

	// Add a new pearl to the database
	await prisma.stasis.create({ data: chamber.toJSON() });

	Logger.log(`  ${ chalk.cyan(player.username) } now has ${ chalk.yellow(existing.length) } / ${ chalk.yellow(MAX_PLAYER_PEARLS) } pearls registered`);
	bot.chat(`/msg ${ player.username } Pearl registered! You have ${ existing.length } out of ${ MAX_PLAYER_PEARLS } pearls registered.`);

});
    