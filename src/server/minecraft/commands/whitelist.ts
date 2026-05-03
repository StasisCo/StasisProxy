import type { Command } from "commander";
import { prisma } from "~/prisma";
import type { CompletionLevel } from "~/server/minecraft/ClientCommands";
import { ClientCommands } from "~/server/minecraft/ClientCommands";

const ALIASES: Record<string, "add" | "remove" | "list"> = {
	add: "add",
	remove: "remove", del: "remove", rm: "remove",
	list: "list", ls: "list"
};

const ACTIONS = Object.keys(ALIASES);

export const completions: CompletionLevel[] = [
	ACTIONS,
	async() => await prisma.client.findMany({ include: { player: { select: { username: true }}}})
		.then(clients => clients.map(c => c.player.username))
];

export default function(program: Command) {
	program
		.command("whitelist")
		.usage(`<${ ACTIONS.join("|") }> [player]`)
		.description("Manage the proxy whitelist")
		.argument("<action>", `The action to perform (${ ACTIONS.join(", ") })`)
		.argument("[player]", "Player username (for add/remove)")
		.action(async function(action: string, player?: string) {

			const act = ALIASES[action.toLowerCase()];
			if (!act) return ClientCommands.usage(this);

			switch (act) {
				case "list": {
					const clients = await prisma.client.findMany({
						where: { whitelisted: true },
						include: { player: { select: { username: true }}}
					});
					if (clients.length === 0) return ClientCommands.reply("§7No whitelisted players.");
					ClientCommands.reply(`§3Whitelisted players (§b${ clients.length }§3):`);
					for (const c of clients) ClientCommands.reply(`§8 - §f${ c.player.username }`);
					return;
				}

				case "add":
				case "remove": {
					if (!player) return ClientCommands.usage(this);

					let record = await prisma.player.findFirst({
						where: { username: { equals: player, mode: "insensitive" }},
						select: { id: true, username: true }
					});

					// Resolve UUID from Mojang and create the player + client.
					if (!record && act === "add") {
						const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${ encodeURIComponent(player) }`);
						if (!res.ok) return ClientCommands.error(`Player §f${ player }§c does not exist.`);
						const profile = await res.json() as { id: string; name: string };
						const uuid = profile.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");

						record = await prisma.player.upsert({
							where: { id: uuid },
							update: {},
							create: { id: uuid, username: profile.name },
							select: { id: true, username: true }
						});
					}

					if (!record) return ClientCommands.error(`Player §f${ player }§c not found.`);

					if (act === "add") {
						await prisma.client.upsert({
							where: { id: record.id },
							update: { whitelisted: true },
							create: { id: record.id, whitelisted: true }
						});
						return ClientCommands.reply(`§3Added §b${ record.username }§3 to the whitelist.`);
					}

					const existing = await prisma.client.findUnique({ where: { id: record.id }});
					if (!existing?.whitelisted) return ClientCommands.error(`§f${ record.username }§c is not whitelisted.`);

					await prisma.client.update({
						where: { id: record.id },
						data: { whitelisted: false }
					});
					return ClientCommands.reply(`§3Removed §b${ record.username }§3 from the whitelist.`);
				}
			}
		});
}
