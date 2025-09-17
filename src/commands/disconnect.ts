import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { formatPlayer, printObject } from "../utils/format";

export const aliases = [ "disconnect", "dc", "exit" ];

export const admin = true;

/**
 * Disconnect and exit the bot
 */
export default async function(player: Player) {

	Logger.log("Disconnecting per user request:");
	printObject({ from: formatPlayer(player) });

	Bot.instance.waitForTicks(1).then(function() {
		Bot.instance.quit();
		process.exit(0);
	});

	return "Disconnecting...";

}