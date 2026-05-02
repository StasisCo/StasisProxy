import type { Command } from "commander";
import type { Vec3 } from "vec3";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";

export default function(program: Command) {
	program
		.command("sethome")
		.description("Sets the home position to your current location")
		.action(async() => {

			const { player } = ChatCommandManager.context;

			// Locate the player in render distance
			const target = MinecraftClient.bot.players[player.username];
			if (!target?.entity) return;

			// Set the home position to the center of the players current block
			const floored = target.entity.position.floored() as Vec3;
			const home = floored.offset(0.5, 0, 0.5) as Vec3;
			
			MinecraftClient.pathfinding.setHome(home);
			MinecraftClient.chat.whisper(player, "Home position set to your current location.");

		});
}
