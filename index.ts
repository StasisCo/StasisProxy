import { PrismaClient } from "@prisma/client";
import { Glob } from "bun";
import { Bot } from "./class/Bot";

// Connect to the database
export const prisma = new PrismaClient();

// Disconnect prisma on exit
process.once("beforeExit", () => prisma.$disconnect());

// Create and login the bot
const bot = await Bot.connect();

// Iterate over all files in modules folder
for await (const path of new Glob("modules/*.ts").scan()) {
	const module = await import(`./${ path }`);
	if (typeof module.default !== "function") continue;
	await module.default(bot);
}

// 
// 
// 
// 
// 
// 
// 
// 
// 
// // 

// const MAX_PLAYER_PEARLS = 2;

// // // queue of Vec3 block positions to interact with
// const queuedChambers: Chamber[] = [];

// // On pearl throw
// bot.on("entitySpawn", async function(entity) {

// 	// Make sure its an ender pearl
// 	if (!entity.uuid || entity.type !== "projectile" || entity.name !== "ender_pearl") return;

// 	// Get the world identifier
// 	const world = `${ bot._client.socket.remoteAddress }:${ bot._client.socket.remotePort || 25565 }+${ bot.game.dimension };${ process.env.LOCATION_KEY || "default" }`;

// 	// Determine who threw the pearl
// 	const player = Object.values(bot.entities)
// 		.filter(e => e.position.distanceTo(entity.position) <= 2)
// 		.filter(e => e.type === "player" && e.username !== bot.username)
// 		.sort((a, b) => a.position.distanceTo(entity.position) - b.position.distanceTo(entity.position))[0];
// 	if (!player || !player.uuid) return;

// 	// Get the pearls blockPosition
// 	const blockPos = bot.blockAt(entity.position);
// 	if (!blockPos) return;

// 	// Get the chamber from the block position
// 	const chamber = Chamber.fromBlockPosition(blockPos.position);
// 	if (!chamber) return;

// 	// Get the interaction block for the chamber
// 	const interactionBlock = chamber.getInteractionBlock();
// 	if (!interactionBlock) return;

// 	// Make sure theres not already a different pearl in this chamber
// 	const occupants = chamber.getOccupants().filter(e => e.uuid !== entity.uuid);
// 	if (occupants.length > 0) return Logger.warn(`${ chalk.cyan(player.username) } threw a pearl into an occupied stasis column. ${ chalk.yellow(interactionBlock.position) } ${ chalk.gray("(ignoring)") }`);

// 	// Wait for the pearl to stop moving at the trapdoor
// 	await new Promise<void>(function loop(resolve) {
// 		const distance = entity.position.distanceTo(interactionBlock.position);
// 		if (distance <= 1 && entity.velocity.abs().x <= 0.1 && entity.velocity.abs().y <= 0.1 && entity.velocity.abs().z <= 0.1) return resolve();
// 		bot.waitForTicks(1).then(() => loop(resolve));
// 	});

// 	// Get all the active pearls in the database for this player
// 	const pearls = await prisma.pearl.findMany({ where: { player: player.uuid, world }})
// 		.then(pearls => pearls.filter(pearl => Chamber.fromBlockPosition(new Vec3(pearl.x, pearl.y, pearl.z))?.isOccupied()))
// 		.then(pearls => pearls.filter(pearl => !(pearl.x === interactionBlock.position.x && pearl.y === interactionBlock.position.y && pearl.z === interactionBlock.position.z)));

// 	// If they have too many, remove this pearl and ignore it
// 	if (pearls.length >= MAX_PLAYER_PEARLS) {
// 		bot.chat(`/msg ${ player.username } You already have ${ pearls.length } / ${ MAX_PLAYER_PEARLS } pearls registered. Extra pearls will be removed!`);
// 		Logger.warn(`${ chalk.cyan(player.username) } threw a pearl into the stasis column at ${ chalk.yellow(interactionBlock.position) } exceeding the pearl limit of ${ chalk.yellow(MAX_PLAYER_PEARLS) }. ${ chalk.gray("(queueing removal)") }`);
// 		queuedChambers.push(chamber);
// 		return;
// 	}

// 	// Clear any existing pearl data for this chamber
// 	await prisma.pearl.deleteMany({
// 		where: {
// 			world,
// 			x: interactionBlock.position.x,
// 			y: interactionBlock.position.y,
// 			z: interactionBlock.position.z
// 		}
// 	});

// 	// Add a new pearl to the database
// 	await prisma.pearl.create({
// 		data: {
// 			player: player.uuid,
// 			world,
// 			x: interactionBlock.position.x,
// 			y: interactionBlock.position.y,
// 			z: interactionBlock.position.z
// 		}
// 	});

// 	bot.chat(`/msg ${ player.username } Pearl registered! You have ${ pearls.length + 1 } out of ${ MAX_PLAYER_PEARLS } pearls registered.`);
// 	Logger.log(`${ chalk.cyan(player.username) } threw a pearl into the stasis column at ${ chalk.yellow(interactionBlock.position) } and now has ${ chalk.yellow(pearls.length + 1) } out of ${ chalk.yellow(MAX_PLAYER_PEARLS) } pearls registered. ${ chalk.gray("(registered)") }`);

// });

// // Accept dm's from players
// bot.on("whisper", async function(username, message) {

// 	// TODO: make it some kind of command syntax

// 	// Get the player
// 	const player = Object.values(bot.players)
// 		.find(e => e.username === username);
// 	if (!player || !player.uuid) return;
	
// 	// Get the chambers for this player
// 	const world = `${ bot._client.socket.remoteAddress }:${ bot._client.socket.remotePort || 25565 }+${ bot.game.dimension };${ process.env.LOCATION_KEY || "default" }`;
// 	const pearls = await prisma.pearl.findMany({ where: { player: player.uuid, world }})
// 		.then(pearls => pearls.filter(pearl => Chamber.fromBlockPosition(new Vec3(pearl.x, pearl.y, pearl.z))?.isOccupied()));

// 	// If they have no pearls, inform them and exit
// 	if (pearls.length === 0) {
// 		bot.chat(`/msg ${ username } You have no pearls registered!`);
// 		return Logger.warn(`${ chalk.cyan(username) } requested their pearl to be loaded, but they have no pearls registered. ${ chalk.gray("(ignoring)") }`);
// 	}

// 	// Make sure they dont have a pearl already queued
// 	const queuedPlayers = await Promise.all(queuedChambers.map(chamber => chamber.getOwner()));
// 	if (queuedPlayers.find(e => e?.uuid === player.uuid)) {
// 		bot.chat(`/msg ${ username } You already have a pearl being loaded, please wait...`);
// 		return Logger.warn(`${ chalk.cyan(username) } requested their pearl to be loaded, but they already have a pearl being loaded. ${ chalk.gray("(ignoring)") }`);
// 	}

// 	// Load the first available pearl
// 	const pearl = pearls[0];
// 	if (!pearl) return;
	
// 	const chamber = Chamber.fromBlockPosition(new Vec3(pearl.x, pearl.y - 1, pearl.z));
// 	if (!chamber) return;

// 	const interactionBlock = chamber.getInteractionBlock();
// 	if (!interactionBlock) return;

// 	queuedChambers.push(chamber);
// 	bot.chat(`/msg ${ username } Loading your pearl, please wait...`);

// });

// // External state
// let currentGoal: Chamber | null = null;
// let homePos: Vec3 | null = null; // set only when queue transitions empty -> non-empty
// let returningHome = false; // are we currently navigating back home?

// // Tick loop
// bot.on("physicsTick", async function() {

// 	// --- If we’re working on a chamber, finish that first ---
// 	if (currentGoal) {
// 		const interactionBlock = currentGoal.getInteractionBlock();
// 		if (!interactionBlock) {
// 			currentGoal = null;
// 			return;
// 		}

// 		const dist = bot.entity.position.distanceTo(interactionBlock.position);
// 		if (dist <= 3) {

// 			// Arrived → interact once, then advance
// 			currentGoal = null;

// 			Logger.log(`Arrived at chamber at ${ chalk.yellow(interactionBlock.position) } , loading...`);
// 			await bot.lookAt(interactionBlock.position, true);
// 			await bot.activateBlock(interactionBlock);

// 			// Next tick will pick up the next chamber or start returning home
// 		}
// 		return;
// 	}

// 	// --- Not currently on a chamber ---

// 	// If there’s queued work:
// 	if (queuedChambers.length > 0) {

// 		// Capture home only when a new work session starts (empty -> non-empty)
// 		if (homePos === null) homePos = bot.entity.position.clone();

// 		// If we were heading home, cancel that and do work (keep original homePos)
// 		returningHome = false;

// 		const chamber = queuedChambers.shift()!;
// 		const interactionBlock = chamber.getInteractionBlock();
// 		if (!interactionBlock) return; // skip this one; next tick will try again

// 		currentGoal = chamber;
// 		bot.pathfinder.setGoal(new goals.GoalNear(interactionBlock.position.x, interactionBlock.position.y, interactionBlock.position.z, 2));
// 		return;
// 	}

// 	// --- Queue is empty ---
// 	// If we have a saved home and we're not there yet, go home.
// 	if (homePos) {
// 		const dHome = bot.entity.position.distanceTo(homePos);
// 		if (dHome > 1) {
// 			if (!returningHome) {
// 				returningHome = true;
// 				bot.pathfinder.setGoal(new goals.GoalBlock(homePos.x, homePos.y, homePos.z));
// 			}

// 			// keep walking; don't clear goal every tick
// 			return;
// 		}

// 		// We arrived home with no new work → end session
// 		returningHome = false;

// 		// Keep goal as-is (already satisfied) to avoid pathfinder thrash.
// 		// If you *really* want to clear it once, do it here (but don't call stop()):
// 		// bot.pathfinder.setGoal(null);
// 		homePos = null; // allow a new home to be captured next time work starts
// 	}
// });

// // // Disconnect if health is lower then 4
// // bot.on("health", () => {
// // 	if (bot.health < 4) {
// // 		Logger.error("Health is low, disconnecting...");
// // 		bot.quit();
// // 	}
// // });

