import type { Command } from "commander";
import { ChatCommandManager } from "~/client/minecraft/ChatCommands";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { STASIS_LOCATION_NAME, STASIS_USER_MAX } from "~/config";
import { StasisManager } from "~/manager/StasisManager";

export default function(program: Command) {
	program
		.command("load")
		.description("Loads a stasis at a location")
		.argument("[location]", "Location of the stasis to trigger")
		.action(async(location?: string) => {
			
			const { player, method } = ChatCommandManager.context;
			switch (method) {

				case "chat":
				case "irc": {
						
					// If the chat message comes in thru a public source, verify the location argument before proceeding
					if (!location || !STASIS_LOCATION_NAME.split(",").includes(location)) break;
						
				}
				
				case "whisper": {
					
					// Get the sender of the command and their pearls, sorting by distance to the bot
					const sender = MinecraftClient.bot.players[player.username];
					if (!sender) return;

					// Find all stasis chambers for this player, sorted by distance to the bot
					const pearls = await StasisManager.enqueue(sender.uuid);
					if (pearls === -1) throw new Error("You have no pearls registered!");

					// If they have pearls, but are at the limit, inform them and exit
					MinecraftClient.chat.whisper(sender, `Loading your pearl, you have ${ pearls } / ${ STASIS_USER_MAX } pearls remaining.`);
					break;

				}

			}

		});

}
