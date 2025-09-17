import chalk from "chalk";
import { merge, omit } from "lodash";
import { type Bot as BotType } from "mineflayer";
import { Entity } from "prismarine-entity";
import { prisma } from "..";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { Stasis } from "../class/Stasis";
import { StasisQueue } from "../class/StasisQueue";
import { STASIS_DISTANCE_MAX, STASIS_USER_MAX } from "../config";
import { formatPlayer, printObject } from "../utils/format";

export default async(bot: BotType) => {

	async function onSpawn(entity: Entity) {

		if (!entity.uuid) return;

		// Player visual range
		if (entity.type === "player" && Object.values(bot.players).some(e => e.uuid === entity.uuid) && entity.username) {

			Logger.log("Player entered visual range:");
			printObject({
				player: formatPlayer(entity.uuid),
				position: entity.position.floored()
			});

			// Add last seen timestamp and username to the database
			await prisma.players.upsert({
				where: {
					observer_server_uuid_unique: {
						observer: bot.player.uuid,
						server: Bot.server,
						uuid: entity.uuid
					}
				},
				update: merge(entity.position, {
					lastSeen: new Date(),
					username: entity.username
				}),
				create: merge(entity.position, {
					observer: bot.player.uuid,
					server: Bot.server,
					username: entity.username,
					uuid: entity.uuid
				})
			});

		}

		// Make sure its an ender pearl
		if (entity.type !== "projectile" || entity.name !== "ender_pearl") return;

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

		// Make sure the stasis is within range of the bots home position
		if (STASIS_DISTANCE_MAX >= 0 && stasis.block.position.distanceTo(StasisQueue.home) > STASIS_DISTANCE_MAX) return;

		// Make sure theres not already a different pearl in this chamber
		const occupants = stasis.entities.filter(e => e.uuid !== entity.uuid);
		if (occupants.length > 0) {
			const current = await prisma.pearls.findFirst({
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
		await prisma.pearls.deleteMany({ where: omit(stasis.toJSON(), "owner", "id", "createdAt") });
		
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
		if (pearls.length >= STASIS_USER_MAX && STASIS_USER_MAX >= 0) {
			bot.chat(`/msg ${ player.username } You already have ${ pearls.length } / ${ STASIS_USER_MAX } pearls registered. Extra pearls will be removed!`);

			Logger.warn("Player attempted to add a stasis, but they have too many registered:");
			printObject({
				action: "queueing",
				dimension: stasis.dimension,
				player: formatPlayer(player),
				position: stasis.block.position,
				"registered pearls": `${ chalk.yellow(pearls.length) } ${ chalk.gray("/") } ${ chalk.yellow(STASIS_USER_MAX) }`
			});

			StasisQueue.add(stasis);
			return;
		}

		// include the new pearl being added
		pearls.push(stasis);

		// Add a new pearl to the database
		await prisma.pearls.create({ data: stasis.toJSON() });

		// Log it
		Logger.log("Player registered a new pearl:");
		printObject({
			dimension: stasis.dimension,
			player: formatPlayer(player),
			position: stasis.block.position,
			"registered pearls": `${ chalk.yellow(pearls.length) } ${ chalk.gray("/") } ${ chalk.yellow(STASIS_USER_MAX) }`
		});

		bot.chat(`/msg ${ player.username } Pearl registered! You have ${ pearls.length } out of ${ STASIS_USER_MAX } pearls registered.`);

	}

	bot.on("entitySpawn", onSpawn);

	// Run once for all entities already present (in case of a bot restart)
	for (const entity of Object.values(bot.entities)) await onSpawn(entity);

};