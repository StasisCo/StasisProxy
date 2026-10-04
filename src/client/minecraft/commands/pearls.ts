import type { Command } from "commander";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";
import { ClusterManager } from "~/client/minecraft/manager/ClusterManager";
import { STASIS_LOCATION_NAMES, STASIS_SITE_MAX } from "~/config";

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

				}

				// A direct message is addressed to the bot on purpose, like a whisper
				case "dm":
				case "whisper": {

					// Get the sender of the command
					const sender = MinecraftClient.bot.players[player.username];
					if (!sender) return;

					// Count their pearls at this site, and across every site that shares its name
					const { local, total } = await ClusterManager.survey(sender.uuid);
					ChatCommandManager.reply(`You have ${ local } / ${ STASIS_SITE_MAX } pearls${ ClusterManager.totalSuffix(local, total) }.`);

				}

			}

		});

}
