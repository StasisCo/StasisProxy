import chalk from "chalk";
import type { Command } from "commander";
import { Routes } from "discord.js";
import { DiscordClient } from "~/client/discord/DiscordClient";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";
import { prisma } from "~/prisma";
import { redis } from "~/redis";
import { normalizeUUID } from "~/utils";

export default function(program: Command) {
	program
		.command("connect")
		.alias("link")
		.description("Connect a Discord account")
		.argument("<code>", "The code to connect your Minecraft account with")
		.action(async(code: string) => {
			const { player } = ChatCommandManager.context;

			// Cluster lock: only one bot responds to a given /connect attempt.
			// Without this every online bot processes the command and whispers
			// "Invalid or expired code." on a stale code. 10s TTL is enough
			// for the linking work; the `:user` key is deleted on success
			// which prevents re-runs anyway.
			const lock = await redis.set(`stasisproxy:discord:ignlink:${ code }:lock`, true, "NX", "EX", "10");
			if (lock !== "OK") return;

			// Get the Discord UID associated with the code from Redis
			const linked = await redis.get(`stasisproxy:discord:ignlink:${ code }:user`);
			if (!linked) return void MinecraftClient.chat.whisper(player, "Invalid or expired code.");

			const user = await DiscordClient.client.users.fetch(linked.id).catch(() => null);
			if (!user) return void MinecraftClient.chat.whisper(player, "Invalid or expired code.");

			const playerId = normalizeUUID(player.uuid);

			// Link the Minecraft account with the Discord account in the database
			try {

				// Ensure the player record exists
				await prisma.player.upsert({
					where: { id: playerId },
					update: { username: player.username },
					create: { id: playerId, username: player.username }
				});

				// Upsert the Discord record and connect the player
				await prisma.discord.upsert({
					where: { id: user.id },
					update: { players: { connect: { id: playerId }}},
					create: { id: user.id, players: { connect: { id: playerId }}}
				});

			} catch (err) {
				DiscordClient.logger.error("Failed to link accounts:", err);
				return void MinecraftClient.chat.whisper(player, "An error occurred while linking your account.");
			}

			// Log the successful linking and clean up the Redis key
			DiscordClient.logger.log(`Linked Minecraft account ${ chalk.cyan(player.uuid) } with Discord account ${ chalk.cyan(user) }`);
			MinecraftClient.chat.whisper(player, "Your account has been connected!");

			// Delete the original interaction message if possible
			const payload = await redis.get(`stasisproxy:discord:ignlink:${ code }:message`).catch(() => null);
			if (payload) await DiscordClient.client.rest.delete(Routes.webhookMessage(payload.applicationId, payload.token, "@original")).catch(() => {});

			// Clean up Redis keys
			await redis.del(`stasisproxy:discord:ignlink:${ code }:user`, `stasisproxy:discord:ignlink:${ code }:message`);

		});

}
