import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Stasis } from "../class/Stasis";
import { StasisQueue } from "../class/StasisQueue";
import { STASIS_DISTANCE_MAX, STASIS_USER_MAX } from "../config";

export const aliases = [ "pearls" ];

/**
 * List how many pearls you have registered
 */
export default async function(player: Player) {
    
	// Get all the active pearls in the database for this player
	const pearls = await Stasis.fetch(player)
		.then(chambers => chambers.filter(chamber => StasisQueue.home.distanceTo(chamber.block.position) <= STASIS_DISTANCE_MAX));

	Bot.instance.chat(`/msg ${ player.username } You have ${ pearls.length } / ${ STASIS_USER_MAX } pearls registered.`);

}