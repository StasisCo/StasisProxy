import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { Stasis } from "../class/Stasis";
import { StasisQueue } from "../class/StasisQueue";
import { formatPlayer, printObject } from "../utils/format";

export const aliases = [ "tp", "teleport" ];

/**
 * Queue yourself for stasis teleport
 */
export default async function(player: Player) {

	// Make sure the player is not already queued
	if (StasisQueue.has(player.uuid)) {
		Bot.instance.chat(`/msg ${ player.username } You already have a pearl in queue, please wait...`);
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
		Bot.instance.chat(`/msg ${ player.username } You have no pearls registered!`);
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
			distance: Bot.instance.entity.position.distanceTo(chamber.block.position)
		}))
		.sort((a, b) => a.distance - b.distance)[0]?.chamber;
	if (!chamber) return;
    
	StasisQueue.add(chamber);
	Bot.instance.chat(`/msg ${ player.username } Loading your pearl, please wait...`);

}