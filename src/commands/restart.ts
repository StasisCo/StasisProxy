import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { formatPlayer, printObject } from "../utils/format";

export const aliases = [ "restart", "reconnect" ];

export const admin = true;

/**
 * Disconnect and exit the bot with a non-zero exit code to trigger a restart
 */
export default async function(player: Player) {

	Logger.log("Restarting per user request:");
	printObject({ from: formatPlayer(player) });

	Bot.instance.waitForTicks(1).then(function() {
		Bot.instance.quit();
		process.exit(-1);
	});

	return "Restarting...";

}