import type { Command } from "commander";
import { Vec3 } from "vec3";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { StasisColumn } from "~/client/minecraft/StasisColumn";
import { prisma } from "~/prisma";
import { redis } from "~/redis";
import { zMojangUUID } from "~/schema/mojang/zUUID";
import { zMojangUsername } from "~/schema/mojang/zUsername";
import type { CompletionLevel } from "~/server/minecraft/ClientCommands";
import { ClientCommands } from "~/server/minecraft/ClientCommands";

const ALIASES: Record<string, "save"> = {
	save: "save"
};

const ACTIONS = Object.keys(ALIASES);

export const completions: CompletionLevel[] = [
	ACTIONS,
	() => Object.values(MinecraftClient.bot?.players ?? {})
		.map(p => p.username)
		.filter((name): name is string => typeof name === "string")
		.sort()
];

/**
 * Resolve a username-or-UUID input into a `{ uuid, username }` pair.
 * - Accepts dashed (8-4-4-4-12) or undashed (32 hex) UUIDs and looks up the
 *   current username via Mojang's profile endpoint, falling back to the DB.
 * - Accepts a plain Minecraft username and looks up the UUID via Mojang,
 *   falling back to the DB.
 * Returns null when the input cannot be resolved to a valid Mojang profile.
 */
async function resolveOwner(input: string): Promise<{ uuid: string; username: string } | null> {

	// UUID path: 32-char hex (with or without dashes).
	const stripped = input.replace(/-/g, "");
	const uuidParse = zMojangUUID.safeParse(stripped);
	if (uuidParse.success) {
		const uuid = uuidParse.data;
		const cached = await prisma.player.findUnique({
			where: { id: uuid },
			select: { id: true, username: true }
		});
		if (cached) return { uuid: cached.id, username: cached.username };

		const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${ stripped }`);
		if (!res.ok) return null;
		const profile = await res.json() as { id: string; name: string };
		return { uuid, username: profile.name };
	}

	// Username path.
	const nameParse = zMojangUsername.safeParse(input);
	if (!nameParse.success) return null;

	const cached = await prisma.player.findFirst({
		where: { username: { equals: input, mode: "insensitive" }},
		select: { id: true, username: true }
	});
	if (cached) return { uuid: cached.id, username: cached.username };

	const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${ encodeURIComponent(input) }`);
	if (!res.ok) return null;
	const profile = await res.json() as { id: string; name: string };
	const uuid = zMojangUUID.parse(profile.id);
	return { uuid, username: profile.name };
}

export default function(program: Command) {
	program
		.command("stasis")
		.usage(`<${ ACTIONS.join("|") }> <ownerUsernameOrUuid>`)
		.description("Manage stasis chambers")
		.argument("<action>", `The action to perform (${ ACTIONS.join(", ") })`)
		.argument("<owner>", "Owner username or UUID")
		.action(async function(action: string, owner: string) {

			if (!ClientCommands.hasContext) return ClientCommands.error("This command can only be used in-game.");

			const act = ALIASES[action.toLowerCase()];
			if (!act) return ClientCommands.usage(this);

			switch (act) {
				case "save": {
					const pos = ClientCommands.context.serverClient.playerPosition;
					if (!pos) return ClientCommands.error("Could not determine your position yet. Move once and try again.");

					const column = StasisColumn.get(new Vec3(pos.x, pos.y, pos.z));
					if (!column) return ClientCommands.error("No stasis chamber found near you.");

					const resolved = await resolveOwner(owner);
					if (!resolved) return ClientCommands.error(`Could not resolve §f${ owner }§c to a Mojang profile.`);

					// StasisColumn.save reads only `uuid` and `username` from the player object.
					const saved = await column.save({ uuid: resolved.uuid, username: resolved.username } as never);
					if (!saved) return ClientCommands.error("Failed to save stasis to the database.");

					// Propagate the new ownership to any pearls already in this column.
					// Existing Pearl instances spawned before the save have ownerId=undefined
					// and already emitted "owner-failed", so the hologram’s spawn() promise
					// is still waiting on "owner". Setting ownerId + emitting "owner" lets
					// it resolve immediately. Caching in redis ensures that if the player
					// relogs (and the pearl entity respawns), the new Pearl instance
					// resolves owner from the cache instead of falling back to Stasis.from.
					for (const pearl of column.pearls) {
						if (pearl.ownerId === resolved.uuid) continue;
						pearl.ownerId = resolved.uuid;
						pearl.emit("owner", resolved.uuid);
						void redis.set(`stasisproxy:stasis:pearl:${ pearl.entity.id }:owner`, resolved.uuid);
					}

					return ClientCommands.reply(`§3Saved stasis for §b${ resolved.username }§3.`);
				}
			}
		});
}
