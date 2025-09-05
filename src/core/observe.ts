import chalk from "chalk";
import { omit } from "lodash";
import { type Bot } from "mineflayer";
import { prisma } from "..";
import { Logger } from "../class/Logger";
import { Stasis } from "../class/Stasis";
import { StasisQueue } from "../class/StasisQueue";
import { MAX_PLAYER_PEARLS } from "../config";
import { formatPlayer, printObject } from "../utils/format";

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

	// Get the chamber from the block position of the pearl
	let stasis = Stasis.from(blockPos.position, player.uuid);

	// Search the block adjacent in the direction the pearl is moving
	if (!stasis) {

		// wait for a velocity update, or 
		while (entity.velocity.x === 0 && entity.velocity.z === 0) await bot.waitForTicks(1);

		// Otherwise search adjacent blocks by gradually increasing the deviance threshold
		let deviance = 0.01;
		while (!stasis && deviance <= 1) {
			const dx = entity.velocity.x > deviance ? 1 : entity.velocity.x < -deviance ? -1 : 0;
			const dz = entity.velocity.z > deviance ? 1 : entity.velocity.z < -deviance ? -1 : 0;

			const offsetPos = blockPos.position.offset(dx, 0, dz);
			stasis = Stasis.from(offsetPos, player.uuid);

			if (stasis) break;
			deviance += 0.01;
		}

	}

	// If we still dont have a stasis, ignore this pearl
	if (!stasis) return;

	// Make sure theres not already a different pearl in this chamber
	const occupants = stasis.entities.filter(e => e.uuid !== entity.uuid);
	if (occupants.length > 0) {
		const current = await prisma.stasis.findFirst({
			where: {
				x: stasis.block.position.x,
				y: stasis.block.position.y,
				z: stasis.block.position.z,
				dimension: stasis.dimension
			}
		});
		if (current) {
			Logger.warn("Player attempted to use an occupied stasis:");
			printObject({
				dimension: current.dimension,
				"existing owner": formatPlayer(current.owner),
				player: formatPlayer(player),
				position: stasis.block.position
			});
			return;
		}
	}

	// Clear any existing pearl data for this chamber
	await prisma.stasis.deleteMany({ where: omit(stasis.toJSON(), "owner", "id", "createdAt") });
		
	// Wait for the pearl to settle at the trapdoor
	const readied = await stasis.onReady().then(() => true).catch(() => false);
	if (!readied) {
		Logger.warn("Player attempted to use a stasis, but the pearl broke:");
		printObject({
			dimension: stasis.dimension,
			player: formatPlayer(player),
			position: stasis.block.position
		});
		return;
	}

	// Get all the active pearls in the database for this player
	const pearls = await Stasis.fetch(player);

	// If they have too many, remove this pearl and ignore it
	if (pearls.length >= MAX_PLAYER_PEARLS && MAX_PLAYER_PEARLS >= 0) {
		bot.chat(`/msg ${ player.username } You already have ${ pearls.length } / ${ MAX_PLAYER_PEARLS } pearls registered. Extra pearls will be removed!`);

		Logger.warn("Player attempted to add a stasis, but they have too many registered:");
		printObject({
			action: "queueing",
			dimension: stasis.dimension,
			player: formatPlayer(player),
			position: stasis.block.position,
			"registered pearls": `${ chalk.yellow(pearls.length) } ${ chalk.gray("/") } ${ chalk.yellow(MAX_PLAYER_PEARLS) }`
		});

		StasisQueue.add(stasis);
		return;
	}

	// include the new pearl being added
	pearls.push(stasis);

	// Add a new pearl to the database
	await prisma.stasis.create({ data: stasis.toJSON() });

	// Log it
	Logger.log("Player registered a new pearl:");
	printObject({
		dimension: stasis.dimension,
		player: formatPlayer(player),
		position: stasis.block.position,
		"registered pearls": `${ chalk.yellow(pearls.length) } ${ chalk.gray("/") } ${ chalk.yellow(MAX_PLAYER_PEARLS) }`
	});

	bot.chat(`/msg ${ player.username } Pearl registered! You have ${ pearls.length } out of ${ MAX_PLAYER_PEARLS } pearls registered.`);

});
