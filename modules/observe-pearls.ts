import chalk from "chalk";
import { omit } from "lodash";
import { type Bot } from "mineflayer";
import { prisma } from "..";
import { Logger } from "../class/Logger";
import { StasisColumn } from "../class/StasisColumn";
import { StasisQueue } from "../class/StasisQueue";

const MAX_PLAYER_PEARLS = parseInt(process.env.MAX_PLAYER_PEARLS || "2");

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

	// Make sure theres not already a different pearl in this chamber
	const occupants = chamber.entities.filter(e => e.uuid !== entity.uuid);
	if (occupants.length > 0) return Logger.warn(`${ chalk.cyan(player.username) } threw a pearl into an occupied stasis at ${ chalk.yellow(chamber.block.position) }. This pearl will be ignored.`);
		
	// Wait for the pearl to settle at the trapdoor
	await new Promise<void>(function loop(resolve) {
		const distance = entity.position.distanceTo(chamber.block.position);
		if (distance <= 1 && entity.velocity.abs().x <= 0.1 && entity.velocity.abs().y <= 0.1 && entity.velocity.abs().z <= 0.1) return resolve();
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

	// If they have too many, remove this pearl and ignore it
	if (existing.length >= MAX_PLAYER_PEARLS) {
		bot.chat(`/msg ${ player.username } You already have ${ existing.length } / ${ MAX_PLAYER_PEARLS } pearls registered. Extra pearls will be removed!`);
		Logger.warn(`${ chalk.cyan(player.username) } threw a pearl into the stasis at ${ chalk.yellow(chamber.block.position) }, exceeding their limit of ${ chalk.yellow(MAX_PLAYER_PEARLS) } pearls.`);
		StasisQueue.push(chamber);
		return;
	}

	// include the new pearl being added
	existing.push(chamber);
	Logger.log(`${ chalk.cyan(player.username) } set a pearl into the stasis at ${ chalk.yellow(chamber.block.position) }.`);

	// Clear any existing pearl data for this chamber
	await prisma.stasis.deleteMany({ where: omit(chamber.toJSON(), "owner") });

	// Add a new pearl to the database
	await prisma.stasis.create({ data: chamber.toJSON() });

	bot.chat(`/msg ${ player.username } Pearl registered! You have ${ existing.length } out of ${ MAX_PLAYER_PEARLS } pearls registered.`);
	Logger.log(`${ chalk.cyan(player.username) } threw a pearl into the stasis at ${ chalk.yellow(chamber.block.position) } and now has ${ chalk.yellow(pearls.length + 1) } out of ${ chalk.yellow(MAX_PLAYER_PEARLS) } pearls registered. ${ chalk.gray("(registered)") }`);

});
    