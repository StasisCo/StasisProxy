import type { Command } from "commander";
import type { Vec3 } from "vec3";
import { Client } from "~/app/Client";
import { CommandManager } from "~/manager/CommandManager";
import { Logger } from "~/util/Logger";

const logger = new Logger("CMD");

export default function(program: Command) {
	program
		.command("sethome")
		.action(async() => {

			const { player } = CommandManager.context;

			// Locate the player in render distance
			const target = Client.bot.players[player.username];
			if (!target?.entity) return logger.warn("Failed to locate player: %s (not in render distance)", player.username);

			// Set the home position to the center of the players current block
			const floored = target.entity.position.floored() as Vec3;
			const home = floored.offset(0.5, 0, 0.5) as Vec3;
			Client.pathfinding.setHome(home);
			logger.log("Home position updated by %s: %s", player.username, home);

			Client.chat.message(player, "Home position set to your current location.");

		});
}
