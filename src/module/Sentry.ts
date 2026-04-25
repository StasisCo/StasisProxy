// exporimport { Embed, Webhook } from "@vermaysha/discord-webhook";
// import type { Bot } from "mineflayer";
// import stripAnsi from "strip-ansi";
// import { Client } from "~/class/Client";

// export class WebhookLogger {

// 	constructor(private readonly bot: Bot) {
		
// 		this.bot.on("entitySpawn", async entity => {
			
// 			if (entity.type !== "player") return;
// 			const player = Object.values(this.bot.players).find(p => p.entity && p.entity.id === entity.id);
// 			if (!player || player.uuid === Client.bot.player.uuid) return;
			
// 			await this.send(new Embed()
// 				.setTitle(`${ entity.username } Entered Visual Range`)
// 				.setColor(0xEF4444)
// 				.setThumbnail({ url: `https://mc-heads.net/avatar/${ player.uuid.replace(/-/g, "") }/64` })
// 				.addField({ name: "Location", value: `${ stripAnsi(entity.position.floored().toString()) } @ ${ bot.game.dimension }` })
// 				.addField({ name: "Username", value: `${ entity.username }` })
// 				.addField({ name: "UUID", value: `${ entity.uuid }` })
// 				.setFooter({ text: `${ stripAnsi(bot.entity.position.floored().toString()) } @ ${ bot.game.dimension }` })
// 				.setTimestamp());
			
// 		});
        
// 	}
	
// 	public async send(embed: Embed) {
// 		if (!process.env.DISCORD_WEBHOOK_URL) return;
// 		const client = new Webhook(process.env.DISCORD_WEBHOOK_URL);
// 		await client?.addEmbed(embed).send();
// 	}

// }

import { Embed } from "@vermaysha/discord-webhook";
import type { Entity } from "prismarine-entity";
import stripAnsi from "strip-ansi";
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

		await Client.discord.send(new Embed()
			.setTitle(`${ entity.username } Entered Visual Range`)
			.setColor(0xEF4444)
			.setThumbnail({ url: `https://mc-heads.net/avatar/${ player.uuid.replace(/-/g, "") }/64` })
			.addField({ name: "Location", value: `${ stripAnsi(entity.position.floored().toString()) } @ ${ Client.bot.game.dimension }` })
			.addField({ name: "Username", value: `${ entity.username }` })
			.addField({ name: "UUID", value: `${ entity.uuid }` })
			.setFooter({ text: `${ stripAnsi(Client.bot.entity.position.floored().toString()) } @ ${ Client.bot.game.dimension }` })
			.setTimestamp());

	};

	private readonly onEntityGone = async(entity: Entity) => {

		// Get the pearl associated with this entity, if it exists
		const pearl = StasisManager.pearls.get(entity.id);
		if (!pearl) return;

		// Resolve stasis
		const stasis = await Stasis.from(pearl).catch(() => null);
		if (!stasis) return;
		await stasis.remove();

		const owner = await prisma.player.findUnique({ where: { id: stasis.ownerId }});
		if (!owner) return;

		// Fetch remaining stasis chambers for the owner of the pearl
		const remaining = await Stasis.fetch(owner.id);

		await Client.discord.send(new Embed()
			.setTitle("Stasis Broke Unexpectedly")
			.setColor(0x00c3b3)
			.setThumbnail({ url: `https://mc-heads.net/avatar/${ owner.id.replace(/-/g, "") }/64` })
			.addField({ name: "Username", value: `${ owner.username }`, inline: true })
			.addField({ name: "UUID", value: `${ owner.id }`, inline: true })
			.addField({ name: "", value: "" })
			.addField({ name: "Remaining Pearls", value: `${ remaining.length } / ${ STASIS_USER_MAX }`, inline: true })
			.addField({ name: "Location", value: `${ stripAnsi(stasis.block.position.floored().toString()) } @ ${ Client.bot.game.dimension }`, inline: true })
			.setFooter({ text: `${ stripAnsi(Client.bot.entity.position.floored().toString()) } @ ${ Client.bot.game.dimension }` })
			.setTimestamp());

	};

}
