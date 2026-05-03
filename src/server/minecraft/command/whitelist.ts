import type { Command } from "commander";
import { prisma } from "~/prisma";
import { ClientCommandManager } from "~/server/minecraft/ClientCommandManager";

const ACTIONS = [ "add", "remove", "list" ] as const;

export const completions = [ [ ...ACTIONS ] ];

export default function(program: Command) {
	program
		.command("whitelist")
		.description("Manage the proxy whitelist")
		.argument("[action]", "add | remove | list")
		.argument("[player]", "Player username (for add/remove)")
		.action(async(action?: string, player?: string) => {
			const act = action?.toLowerCase();

			if (!act || !ACTIONS.includes(act as typeof ACTIONS[number])) {
				ClientCommandManager.reply(`§eUsage: §7/whitelist <${ ACTIONS.join("|") }> [player]`);
				return;
			}

			if (act === "list") {
				const clients = await prisma.client.findMany({
					where: { whitelisted: true },
					include: { player: { select: { username: true } } }
				});
				if (clients.length === 0) {
					ClientCommandManager.reply("§7No whitelisted players.");
					return;
				}
				ClientCommandManager.reply(`§eWhitelisted players (${clients.length}):`);
				for (const c of clients) {
					ClientCommandManager.reply(`§7 - §f${ c.player.username }`);
				}
				return;
			}

			if (!player) {
				ClientCommandManager.reply(`§cUsage: §7/whitelist ${ act } <player>`);
				return;
			}

			const record = await prisma.player.findFirst({
				where: { username: { equals: player, mode: "insensitive" } },
				select: { id: true, username: true }
			});

			if (!record) {
				ClientCommandManager.reply(`§cPlayer §f${ player }§c not found in the database.`);
				return;
			}

			if (act === "add") {
				await prisma.client.upsert({
					where: { id: record.id },
					update: { whitelisted: true },
					create: {
						id: record.id,
						remoteAddress: "unknown",
						whitelisted: true
					}
				});
				ClientCommandManager.reply(`§aAdded §f${ record.username }§a to the whitelist.`);
			} else {
				const existing = await prisma.client.findUnique({ where: { id: record.id } });
				if (!existing || !existing.whitelisted) {
					ClientCommandManager.reply(`§c${ record.username } is not whitelisted.`);
					return;
				}
				await prisma.client.update({
					where: { id: record.id },
					data: { whitelisted: false }
				});
				ClientCommandManager.reply(`§cRemoved §f${ record.username }§c from the whitelist.`);
			}
		});
}
