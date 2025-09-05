import chalk from "chalk";
import { type Bot } from "mineflayer";
import { prisma } from "..";
import { Chamber } from "../class/Chamber";
import { Logger } from "../class/Logger";

export default async function(bot: Bot) {

	// On pearl throw
	bot.on("entitySpawn", async function(entity) {

		// Make sure its an ender pearl
		if (!entity.uuid || entity.type !== "projectile" || entity.name !== "ender_pearl") return;

		// Determine who threw the pearl
		const player = Object.values(bot.entities)
			.filter(e => e.position.distanceTo(entity.position) <= 2)
			.filter(e => e.type === "player" && e.username !== bot.username)
			.sort((a, b) => a.position.distanceTo(entity.position) - b.position.distanceTo(entity.position))[0];
		if (!player || !player.uuid) return;

		// Get the pearls blockPosition
		const blockPos = bot.blockAt(entity.position);
		if (!blockPos) return;

		// Get the chamber from the block position
		const chamber = Chamber.fromBlockPosition(blockPos.position);
		if (!chamber) return;

		// Get the interaction block for the chamber
		const interactionBlock = chamber.getInteractionBlock();
		if (!interactionBlock) return;

		// Make sure theres not already a different pearl in this chamber
		const occupants = chamber.getOccupants().filter(e => e.uuid !== entity.uuid);
		if (occupants.length > 0) return Logger.warn(`${ chalk.cyan(player.username) } threw a pearl into an occupied stasis column. ${ chalk.yellow(interactionBlock.position) } ${ chalk.gray("(ignoring)") }`);

		// Wait for the pearl to settle at the trapdoor
		await new Promise<void>(function loop(resolve) {
			const distance = entity.position.distanceTo(interactionBlock.position);
			if (distance <= 1 && entity.velocity.abs().x <= 0.1 && entity.velocity.abs().y <= 0.1 && entity.velocity.abs().z <= 0.1) return resolve();
			bot.waitForTicks(1).then(() => loop(resolve));
		});

		// Get all the active pearls in the database for this player
		const pearls = await prisma.chamber.findMany({
			where: {
				botUUID: bot.player.uuid,
				ownerUUID: player.uuid,
				dimension: bot.game.dimension
			}
		})

			// Get the chamber for each pearl
			.then(chambers => chambers.map(chamber => Chamber.from(chamber)));

		// .then(pearls => pearls.filter(pearl => Chamber.fromBlockPosition(new Vec3(pearl.x, pearl.y, pearl.z))?.isOccupied()))
		// .then(pearls => pearls.filter(pearl => !(pearl.x === interactionBlock.position.x && pearl.y === interactionBlock.position.y && pearl.z === interactionBlock.position.z)));

		// // If they have too many, remove this pearl and ignore it
		// if (pearls.length >= MAX_PLAYER_PEARLS) {
		// 	bot.chat(`/msg ${ player.username } You already have ${ pearls.length } / ${ MAX_PLAYER_PEARLS } pearls registered. Extra pearls will be removed!`);
		// 	Logger.warn(`${ chalk.cyan(player.username) } threw a pearl into the stasis column at ${ chalk.yellow(interactionBlock.position) } exceeding the pearl limit of ${ chalk.yellow(MAX_PLAYER_PEARLS) }. ${ chalk.gray("(queueing removal)") }`);
		// 	queuedChambers.push(chamber);
		// 	return;
		// }

		// // Clear any existing pearl data for this chamber
		// await prisma.pearl.deleteMany({
		// 	where: {
		// 		world,
		// 		x: interactionBlock.position.x,
		// 		y: interactionBlock.position.y,
		// 		z: interactionBlock.position.z
		// 	}
		// });

		// // Add a new pearl to the database
		// await prisma.pearl.create({
		// 	data: {
		// 		player: player.uuid,
		// 		world,
		// 		x: interactionBlock.position.x,
		// 		y: interactionBlock.position.y,
		// 		z: interactionBlock.position.z
		// 	}
		// });

		// bot.chat(`/msg ${ player.username } Pearl registered! You have ${ pearls.length + 1 } out of ${ MAX_PLAYER_PEARLS } pearls registered.`);
		// Logger.log(`${ chalk.cyan(player.username) } threw a pearl into the stasis column at ${ chalk.yellow(interactionBlock.position) } and now has ${ chalk.yellow(pearls.length + 1) } out of ${ chalk.yellow(MAX_PLAYER_PEARLS) } pearls registered. ${ chalk.gray("(registered)") }`);

	});
    
}