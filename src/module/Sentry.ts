import { Embed } from "@vermaysha/discord-webhook";
import type { Entity } from "prismarine-entity";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";
import { Stasis } from "~/class/Stasis";
import { STASIS_USER_MAX } from "~/config";
import { StasisManager } from "~/manager/StasisManager";
import { prisma } from "~/prisma";

export default class Sentry extends Module {

	constructor() {
		super("Sentry");
		Client.bot.on("entitySpawn", this.onEntitySpawn);
		Client.bot.on("entityGone", this.onEntityGone);
	}

	private readonly onEntitySpawn = async(entity: Entity) => {

		// Ensure player
		if (entity.type !== "player") return;

		// Get player
		const player = Object.values(Client.bot.players).find(p => p.entity && p.entity.id === entity.id);
		if (!player || player.uuid === Client.bot.player.uuid) return;

		// If this player was pearled within the last 1s, ignore their spawn to avoid logging pearl-induced teleports as new players entering render distance
		const lastInteraction = StasisManager.interactions.entries().find(([ key ]) => key.ownerId === player.uuid)?.[1];
		if (lastInteraction && Date.now() - lastInteraction < 1000) return;

		await Client.discord.send(new Embed()
			.setTitle(`${ entity.username } Entered Visual Range`)
			.setColor(0x06b6d4)
			.setThumbnail({ url: `https://mc-heads.net/head/${ player.uuid.replace(/-/g, "") }` })
			.addField({ name: "UUID", value: `${ entity.uuid }` })
			.addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
			.addField({ name: "XYZ", value: `||\`${ entity.position.floored().x }\` \`${ entity.position.floored().y }\` \`${ entity.position.floored().z }\`||`, inline: true }));

	};

	private readonly onEntityGone = async(entity: Entity) => {

		// Get the pearl associated with this entity, if it exists
		const pearl = StasisManager.pearls.get(entity.id);
		if (!pearl) return;

		// Resolve stasis
		const stasis = await Stasis.from(pearl).catch(() => null);
		if (!stasis) return;
		
		// If the stasis was interacted within the last 1s, ignore its removal to avoid logging pearl-induced stasis breaks as unexpected breakages
		const lastInteraction = StasisManager.interactions.entries().find(([ key ]) => key.id === stasis.id)?.[1];
		const didIntentionallyPull = lastInteraction && Date.now() - lastInteraction < 1000;
		await stasis.remove();

		const owner = await prisma.player.findUnique({ where: { id: stasis.ownerId }});
		if (!owner) return;

		// Fetch remaining stasis chambers for the owner of the pearl
		const remaining = await Stasis.fetch(owner.id);

		if (didIntentionallyPull) {
			await Client.discord.send(new Embed()
				.setTitle(`${ owner.username } Pearled`)
				.setColor(0x00c3b3)
				.setThumbnail({ url: `https://mc-heads.net/head/${ owner.id.replace(/-/g, "") }` })
				.addField({ name: "UUID", value: `${ owner.id }` })
				.addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
				.addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
				.addField({ name: "Pearls", value: `${ remaining.length } / ${ STASIS_USER_MAX }` }));
			return;
		}

		await Client.discord.send(new Embed()
			.setTitle("Stasis Broke Unexpectedly")
			.setColor(0xf43f5e)
			.setThumbnail({ url: `https://mc-heads.net/head/${ owner.id.replace(/-/g, "") }` })
			.addField({ name: "UUID", value: `${ entity.uuid }` })
			.addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
			.addField({ name: "XYZ", value: `||\`${ entity.position.floored().x }\` \`${ entity.position.floored().y }\` \`${ entity.position.floored().z }\`||`, inline: true })
			.addField({ name: "Pearls", value: `${ remaining.length } / ${ STASIS_USER_MAX }` }));

	};

}
