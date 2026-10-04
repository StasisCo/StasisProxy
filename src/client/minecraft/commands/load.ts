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
					const name = location?.toLowerCase();
					if (!name || !STASIS_LOCATION_NAMES.includes(name)) break;

					// Every site with this name heard the same message, so only one of them gets to act on it
					if (!await ClusterManager.claim("load", name, player.uuid)) break;

					// Have whichever of those sites is nearest to one of their pearls load it
					if (!await ClusterManager.load(player.uuid, name)) throw new Error("You have no pearls registered!");
					break;

				}

				// A direct message is addressed to the bot on purpose, like a whisper
				case "dm":
				case "whisper": {

					// Get the sender of the command
					const sender = MinecraftClient.bot.players[player.username];
					if (!sender) return;

					// They asked this bot, so the pearl is loaded at this site
					const message = await ClusterManager.pull(sender.uuid);
					if (!message) throw new Error("You have no pearls registered!");

					ChatCommandManager.reply(message);
					break;

				}

			}

		});

}
