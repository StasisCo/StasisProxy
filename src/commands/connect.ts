import type { Command } from "commander";
import { CommandManager } from "~/manager/CommandManager";
import { redis } from "~/redis";

export default function(program: Command) {
	program
		.command("connect")
		.description("Connect a Discord account")
		.argument("<code>", "The code to connect your Minecraft account with")
		.action(async(code?: string) => {
			if (!code) return;
			
			const { player } = CommandManager.context;

			const discordUid = await redis.get(`ign-link:${ code }`);
			console.log(discordUid, player.uuid);

		});

}
