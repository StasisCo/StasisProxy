import type { Command } from "commander";
import type { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { CommandManager } from "~/manager/CommandManager";

export default function(program: Command) {
	program
		.command("sethome")
		.action(async() => {

			const { player } = CommandManager.context;

			// Locate the player in render distance
			const target = Client.bot.players[player.username];
			if (!target?.entity) return;

			// Set the home position to the center of the players current block
			const floored = target.entity.position.floored() as Vec3;
			const home = floored.offset(0.5, 0, 0.5) as Vec3;
			
			Client.pathfinding.setHome(home);
			Client.chat.message(player, "Home position set to your current location.");

		});
}
