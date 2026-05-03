import type { Command } from "commander";
import { ClientCommandManager } from "~/server/minecraft/ClientCommandManager";

export default function(program: Command) {
	program
		.command("stasis")
		.description("List players with stasis chambers in render distance")
		.action(async() => {
			if (!ClientCommandManager.hasContext) {
				ClientCommandManager.reply("§cThis command can only be used in-game.");
				return;
			}

			const { serverClient } = ClientCommandManager.context;
			await serverClient.openStasisListGui();
		});
}
