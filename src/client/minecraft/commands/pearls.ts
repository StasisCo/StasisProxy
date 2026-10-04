import type { Command } from "commander";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";
import { ClusterManager } from "~/client/minecraft/manager/ClusterManager";
import { STASIS_LOCATION_NAMES } from "~/config";

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
					if (!location || !STASIS_LOCATION_NAMES.includes(location.toLowerCase())) break;

					// Every bot at this location heard the same message, so only one of them gets to answer it
					if (!await ClusterManager.claim("pearls", location.toLowerCase(), player.uuid)) break;

				}

				// A direct message is addressed to the bot on purpose, like a whisper
				case "dm":
				case "whisper": {

					// Get the sender of the command
					const sender = MinecraftClient.bot.players[player.username];
					if (!sender) return;

					// Count their pearls across every bot at this location
					const { total, limit } = await ClusterManager.survey(sender.uuid);
					ChatCommandManager.reply(`You have ${ total } / ${ limit } pearls.`);

				}

			}

		});

}
