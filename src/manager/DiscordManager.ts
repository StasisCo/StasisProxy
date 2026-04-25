import { Webhook, type Embed } from "@vermaysha/discord-webhook";
import type { Bot } from "mineflayer";

export class DiscordManager {

	constructor(private readonly bot: Bot) {}

	public async send(embed: Embed) {
		if (!process.env.DISCORD_WEBHOOK_URL) return;
		const client = new Webhook(process.env.DISCORD_WEBHOOK_URL);
		await client?.addEmbed(embed).send();
	}

}