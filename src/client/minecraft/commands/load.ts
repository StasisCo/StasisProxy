import type { Command } from "commander";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";
import { ClusterManager } from "~/client/minecraft/manager/ClusterManager";
import { STASIS_LOCATION_NAMES } from "~/config";

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
					if (!location || !STASIS_LOCATION_NAMES.includes(location.toLowerCase())) break;

					// Every bot at this location heard the same message, so only one of them gets to answer it
					if (!await ClusterManager.claim("load", location.toLowerCase(), player.uuid)) break;

				}

				// A direct message is addressed to the bot on purpose, like a whisper
				case "dm":
				case "whisper": {

					// Get the sender of the command
					const sender = MinecraftClient.bot.players[player.username];
					if (!sender) return;

					// Have whichever bot at this location is nearest to one of their pearls load it
					const loaded = await ClusterManager.load(sender.uuid);
					if (!loaded) throw new Error("You have no pearls registered!");

					ChatCommandManager.reply(`Loading your pearl, you have ${ loaded.remaining } / ${ loaded.limit } pearls remaining.`);
					break;

				}

			}

		});

}
