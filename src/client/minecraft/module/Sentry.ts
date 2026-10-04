import { Embed } from "@vermaysha/discord-webhook";
import type { Entity } from "prismarine-entity";
import { DiscordClient } from "~/client/discord/DiscordClient";
import { ClusterManager } from "~/client/minecraft/manager/ClusterManager";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { Stasis } from "~/client/minecraft/Stasis";
import { STASIS_SITE_MAX, STASIS_USER_MAX } from "~/config";
import { prisma } from "~/prisma";
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";

export default class Sentry extends Module {

	constructor() {
		super("Sentry");
	}

	// Listeners must be (re)attached in onReady — the bot instance is recreated on every
	// reconnect, so constructor-time registration dies with the first connection.
	public override onReady() {
		MinecraftClient.bot.off("entitySpawn", this.onEntitySpawn);
		MinecraftClient.bot.off("entityGone", this.onEntityGone);
		MinecraftClient.bot.on("entitySpawn", this.onEntitySpawn);
		MinecraftClient.bot.on("entityGone", this.onEntityGone);
	}

	public override onDisable() {
		MinecraftClient.bot.off("entitySpawn", this.onEntitySpawn);
		MinecraftClient.bot.off("entityGone", this.onEntityGone);
	}

	private readonly onEntitySpawn = async(entity: Entity) => {

		// Ensure player
		if (entity.type !== "player") return;

		// Get player
		const player = Object.values(MinecraftClient.bot.players).find(p => p.entity && p.entity.id === entity.id);
		if (!player || player.uuid === MinecraftClient.bot.player.uuid) return;

		// If this player was pearled within the last 1s, ignore their spawn to avoid logging pearl-induced teleports as new players entering render distance
		const lastInteraction = StasisManager.expectedInteractions.entries().find(([ key ]) => key.ownerId === player.uuid)?.[1];
		if (lastInteraction && Date.now() - lastInteraction < 1000) return;

		await DiscordClient.webhook(new Embed()
			.setTitle(`${ entity.username } Entered Visual Range`)
			.setColor(0x06b6d4)
			.setThumbnail({ url: `https://mc-heads.net/head/${ player.uuid.replace(/-/g, "") }` })
			.addField({ name: "UUID", value: `${ entity.uuid }` })
			.addField({ name: "Dimension", value: `${ MinecraftClient.bot.game.dimension }`, inline: true })
			.addField({ name: "XYZ", value: `||\`${ entity.position.floored().x }\` \`${ entity.position.floored().y }\` \`${ entity.position.floored().z }\`||`, inline: true }));

	};

	private readonly onEntityGone = async(entity: Entity) => {

		switch (entity.type) {

			case "projectile": {

				// Get the pearl associated with this entity, if it exists
				const pearl = StasisManager.pearls.get(entity.id);
				if (!pearl) return;

				// Resolve stasis
				const stasis = await Stasis.from(pearl).catch(() => null);
				if (!stasis) return;
				
				// If the stasis was interacted within the last 1s, ignore its removal to avoid logging pearl-induced stasis breaks as unexpected breakages
				const lastInteraction = StasisManager.expectedInteractions.entries().find(([ key ]) => key.id === stasis.id)?.[1];
				const didIntentionallyPull = lastInteraction && Date.now() - lastInteraction < 1000;
				await stasis.remove();

				const owner = await prisma.player.findUnique({ where: { id: stasis.ownerId }});
				if (!owner) return;

				// Count the owner's remaining pearls at this site, and across every site that shares its name
				const { local, total } = await ClusterManager.survey(owner.id);
				const pearls = `${ local } / ${ STASIS_SITE_MAX }${ ClusterManager.totalSuffix(local, total) }`;

				if (didIntentionallyPull) {
					await DiscordClient.webhook(new Embed()
						.setTitle(`${ owner.username } Pearled`)
						.setColor(0x00c3b3)
						.setThumbnail({ url: `https://mc-heads.net/head/${ owner.id.replace(/-/g, "") }` })
						.addField({ name: "UUID", value: `${ owner.id }` })
						.addField({ name: "Dimension", value: `${ MinecraftClient.bot.game.dimension }`, inline: true })
						.addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
						.addField({ name: "Pearls", value: pearls }));
					return;
				}

				await DiscordClient.webhook(new Embed()
					.setTitle("Stasis Broke Unexpectedly")
					.setColor(0xf43f5e)
					.setThumbnail({ url: `https://mc-heads.net/head/${ owner.id.replace(/-/g, "") }` })
					.addField({ name: "UUID", value: `${ entity.uuid }` })
					.addField({ name: "Dimension", value: `${ MinecraftClient.bot.game.dimension }`, inline: true })
					.addField({ name: "XYZ", value: `||\`${ entity.position.floored().x }\` \`${ entity.position.floored().y }\` \`${ entity.position.floored().z }\`||`, inline: true })
					.addField({ name: "Pearls", value: pearls }));

				break;

			}

			case "player": {

				// Get player
				const player = Object.values(MinecraftClient.bot.players).find(p => p.entity && p.entity.id === entity.id);
				if (!player) return;

				// Every bot that watched them leave would send the same reminder
				if (!await ClusterManager.claim("reminder", player.uuid)) return;

				// Nothing to remind them of when this site is full, or they are at their limit across sites
				const { local, total } = await ClusterManager.survey(player.uuid);
				if (local >= STASIS_SITE_MAX) return;
				if (STASIS_USER_MAX >= 0 && total >= STASIS_USER_MAX) return;

				if (total === 0) return MinecraftClient.chat.whisper(player, `You left without setting any pearls! You can set up to ${ STASIS_SITE_MAX } pearls and use !load to be teleported back.`);
				return MinecraftClient.chat.whisper(player, `You forgot to set a pearl! You only have ${ local } / ${ STASIS_SITE_MAX } pearls registered${ ClusterManager.totalSuffix(local, total) }.`);

			}

		}

	};

}
