import chalk from "chalk";
import type { Command } from "commander";
import { Routes } from "discord.js";
import z from "zod";
import { Client } from "~/class/Client";
import { ChatCommandManager } from "~/manager/ChatCommandManager";
import { DiscordManager } from "~/manager/DiscordManager";
import { prisma } from "~/prisma";
import { redis } from "~/redis";

export default function(program: Command) {
	program
		.command("connect")
		.alias("link")
		.description("Connect a Discord account")
		.argument("<code>", "The code to connect your Minecraft account with")
		.action(async(code: string) => {
			const { player } = ChatCommandManager.context;

			// Get the Discord UID associated with the code from Redis
			const user = await redis.get(`ign-link:${ code }:user`)
				.then(data => data ? JSON.parse(data) : null)
				.then(z.object({ id: z.string() }).parseAsync)
				.then(parsed => DiscordManager.client.users.fetch(parsed.id).catch(() => null));
			if (!user) return;
			
			// Link the Minecraft account with the Discord account in the database, creating a new Discord record if necessary
			await prisma.discord.upsert({
				where: {
					id: user.id
				},
				update: {
					players: {
						connectOrCreate: {
							where: {
								id: player.uuid
							},
							create: {
								id: player.uuid,
								username: player.username
							}
						}
					}
				},
				create: {
					id: user.id,
					players: {
						connectOrCreate: {
							where: {
								id: player.uuid
							},
							create: {
								id: player.uuid,
								username: player.username
							}
						}
					}
				}
			});

			// Log the successful linking and clean up the Redis key
			DiscordManager.logger.log(`Linked Minecraft account ${ chalk.cyan(player.uuid) } with Discord account ${ chalk.cyan(user) }`);
			Client.chat.whisper(player, "Your account has been connected!");

			// // Get the message ID of the original interaction reply to delete it
			// const messageId = await redis.get(`ign-link:${ code }:message`);
			// const message = await DiscordManager.client.channels;
			// Get the Discord UID associated with the code from Redis
			const payload = await redis.get(`ign-link:${ code }:message`)
				.then(data => data ? JSON.parse(data) : null)
				.catch(() => null);

			// New payload format for ephemeral responses
			const interactionPayload = await z.object({
				type: z.literal("interaction-original"),
				applicationId: z.string(),
				token: z.string()
			}).safeParseAsync(payload);
			if (interactionPayload.success) {
				await DiscordManager.client.rest.delete(
					Routes.webhookMessage(interactionPayload.data.applicationId, interactionPayload.data.token, "@original")
				).catch(() => {});
			} else {

				// Legacy payload format fallback
				const legacyPayload = await z.object({
					id: z.string(),
					guildId: z.string(),
					channelId: z.string()
				}).safeParseAsync(payload);
				if (legacyPayload.success) {
					const guild = await DiscordManager.client.guilds.fetch(legacyPayload.data.guildId).catch(() => null);
					const channel = guild ? await guild.channels.fetch(legacyPayload.data.channelId).catch(() => null) : null;
					if (channel?.isTextBased() && "messages" in channel && typeof channel.messages?.fetch === "function") {
						const message = await channel.messages.fetch(legacyPayload.data.id).catch(() => null);
						if (message) await message.delete().catch(() => {});
					}
				}
			}
			await redis.del(`ign-link:${ code }:user`, `ign-link:${ code }:message`);

		});

}
