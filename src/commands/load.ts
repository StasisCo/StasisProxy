import type { Command } from "commander";
import type { Vec3 } from "vec3";
import { Client } from "~/app/Client";
import { Stasis } from "~/class/Stasis";
import { STASIS_LOCATION_NAME, STASIS_USER_MAX } from "~/config";
import { CommandManager } from "~/manager/CommandManager";

export default function(program: Command) {
	program
		.command("load")
		.argument("[location]", "Location of the stasis to trigger")
		.action(async(location?: string) => {
			
			const { player, method } = CommandManager.context;
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

					// If they have no pearls, inform them and exit
					if (!pearls[0]) throw new Error("You have no pearls registered!");

					// If they have pearls, but are at the limit, inform them and exit
					Client.chat.message(sender, `Loading your pearl, you have ${ pearls.length - 1 } / ${ STASIS_USER_MAX } pearls remaining.`);
					pearls[0].enqueue();
					break;

				}

			}

		});

}
