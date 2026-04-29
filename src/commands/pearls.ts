import type { Command } from "commander";
import type { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { Stasis } from "~/class/Stasis";
import { STASIS_LOCATION_NAME, STASIS_USER_MAX } from "~/config";
import { ChatCommandManager } from "~/manager/ChatCommandManager";

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
					const sender = Client.bot.players[player.username];
					if (!sender) return;

					// Find all stasis chambers for this player, sorted by distance to the bot
					const pearls = await Stasis.fetch(sender.uuid)
						.then(stasis => stasis.sort((a, b) => {
							const aDist = a.block.position.distanceTo(Client.bot.entity.position as Vec3);
							const bDist = b.block.position.distanceTo(Client.bot.entity.position as Vec3);
							return aDist - bDist;
						}));

					Client.chat.whisper(sender, `You have ${ pearls.length } / ${ STASIS_USER_MAX } pearls.`);

				}

			}

		});

}
