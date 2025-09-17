import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { StasisQueue } from "../class/StasisQueue";
import { formatPlayer, printObject } from "../utils/format";

export const aliases = [ "sethome" ];

export const permission = "operator";

/**
 * Set the bot's home position to your current position.
 */
export default async function(player: Player) {

	// Locate the player in render distance
	const target = Bot.instance.players[player.username];
	if (!target || !target.entity) {
		Bot.instance.chat(`/msg ${ player.username } You must be in render distance to use this command!`);
		Logger.warn("Failed to locate player:");
		printObject({
			from: formatPlayer(player),
			reason: "Not in render distance"
		});
		return;
	}

	// Set the home position to the players current position
	StasisQueue.home = target.entity.position.floored();

}