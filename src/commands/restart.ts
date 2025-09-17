import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { formatPlayer, printObject } from "../utils/format";

export const aliases = [ "restart", "reconnect" ];

export const permission = "operator";

/**
 * Disconnect and exit the bot with a non-zero exit code to trigger a restart
 */
export default async function(player: Player) {

	Bot.instance.chat(`/msg ${ player.username } Restarting...`);
	Logger.log("Restarting per user request:");
	printObject({ from: formatPlayer(player) });

	Bot.instance.quit();
	process.exit(-1);

}