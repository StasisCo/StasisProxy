import type { Command } from "commander";
import { Stasis } from "~/class/Stasis";
import { ChatCommandManager } from "~/client/minecraft/ChatCommands";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { STASIS_LOCATION_NAME, STASIS_USER_MAX } from "~/config";

export default function(program: Command) {
	program
		.command("pearls")
		.description("Counts the number of pearls you have registered at a location")
		.argument("[location]", "Location to list pearls for")
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
					const pearls = await Stasis.fetch(sender.uuid);
					MinecraftClient.chat.whisper(sender, `You have ${ pearls.length } / ${ STASIS_USER_MAX } pearls.`);

				}

			}

		});

}
