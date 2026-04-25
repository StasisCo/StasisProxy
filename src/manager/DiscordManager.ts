import { Webhook, type Embed } from "@vermaysha/discord-webhook";
import type { Bot } from "mineflayer";

export class DiscordManager {

	constructor(private readonly bot: Bot) {}

	public async send(embed: Embed, attempt = 0) {
		if (!process.env.DISCORD_WEBHOOK_URL) return;
		if (attempt > 2) return;
		const client = new Webhook(process.env.DISCORD_WEBHOOK_URL);
		await client?.addEmbed(embed
			.setFooter({
				icon_url: `https://mc-heads.net/head/${ this.bot.player.uuid.replace(/-/g, "") }`,
				text: this.bot.username
			})
			.setTimestamp()).send().catch(() => this.send(embed, attempt + 1));
	}

}