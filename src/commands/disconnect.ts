import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { formatPlayer, printObject } from "../utils/format";

export const aliases = [ "disconnect", "dc", "exit" ];

export const permission = "operator";

/**
 * Disconnect and exit the bot
 */
export default async function(player: Player) {

	Bot.instance.chat(`/msg ${ player.username } Disconnecting...`);
	Logger.log("Disconnecting per user request:");
	printObject({ from: formatPlayer(player) });

	Bot.instance.quit();
	process.exit(0);

}