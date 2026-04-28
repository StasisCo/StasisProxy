import chalk from "chalk";
import type { Command } from "commander";
import { Client } from "~/class/Client";
import { CommandManager } from "~/manager/CommandManager";
import { DiscordManager } from "~/manager/DiscordManager";
import { prisma } from "~/prisma";
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
			if (!discordUid) return;

			const players = {
				connectOrCreate: {
					where: {
						id: player.uuid
					},
					create: {
						id: player.uuid,
						username: player.username
					}
				}
			};
			
			await prisma.discord.upsert({
				where: {
					id: discordUid
				},
				update: {
					players
				},
				create: {
					id: discordUid,
					players
				}
			});

			DiscordManager.logger.log(`Linked Minecraft account ${ chalk.cyan(player.uuid) } with Discord account ${ chalk.cyan(discordUid) }`);

			await redis.del(`ign-link:${ code }`);

			Client.chat.whisper(player, "Your account has been connected!");

		});

}
