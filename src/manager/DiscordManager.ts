import { Webhook, type Embed } from "@vermaysha/discord-webhook";
import chalk from "chalk";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { readdir } from "fs/promises";
import type { Bot } from "mineflayer";
import { join } from "path";
import { Logger } from "~/class/Logger";

export class DiscordManager {

	public static readonly client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.GuildMembers
		]
	});
	public static readonly logger = new Logger(chalk.hex("#5662f6")("DISCORD"));

	constructor(private readonly bot: Bot) {
		void this.init();
	}

	private async init() {
		if (!process.env.DISCORD_BOT_TOKEN) return;
		await this.loadListeners();
		DiscordManager.logger.log("Connecting to Discord...");
		DiscordManager.client.once(Events.ClientReady, client => DiscordManager.logger.log(`Logged in as ${ chalk.cyan(client.user.tag) } ${ chalk.dim(`@${ client.user.id }`) }`));
		DiscordManager.client.login(process.env.DISCORD_BOT_TOKEN);
	}

	private async loadListeners() {
		const listenersDir = join(__dirname, "..", "discord", "listeners");
		for (const file of await readdir(listenersDir)) {
			if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
			await import(join(listenersDir, file));
		}
	}

	public async webhook(embed: Embed, attempt = 0) {
		if (!process.env.DISCORD_WEBHOOK_URL) return;
		if (attempt > 2) return;
		const client = new Webhook(process.env.DISCORD_WEBHOOK_URL);

		embed.setFooter({
			icon_url: `https://mc-heads.net/head/${ this.bot.player.uuid.replace(/-/g, "") }`,
			text: this.bot.username
		});
		embed.setTimestamp();

		await client?.addEmbed(embed).send().catch(() => this.webhook(embed, attempt + 1));
	}

}