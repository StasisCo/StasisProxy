import { Webhook, type Embed } from "@vermaysha/discord-webhook";
import chalk from "chalk";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { readdir } from "fs/promises";
import { join } from "path";
import prettyMilliseconds from "pretty-ms";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "../minecraft/MinecraftClient";

export class DiscordClient {

	private static initialized = false;

	public static readonly logger = new Logger(chalk.hex("#5662f6")("DISCORD"));

	public static readonly client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.GuildMembers
		]
	});

	public static async init() {

		if (!process.env.DISCORD_BOT_TOKEN) return this.logger.warn("DISCORD_BOT_TOKEN not set, skipping Discord client initialization");

		if (this.initialized) return;
		this.initialized = true;
		
		const listenersDir = join(__dirname, "..", "discord", "listeners");
		for (const file of await readdir(listenersDir)) {
			if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
			await import(join(listenersDir, file))
				.catch(error => this.logger.error("Failed to load Discord event listener:", error));
		}

		const now = Date.now();
		this.client.once(Events.ClientReady, client => DiscordClient.logger.log(`Authenticated as ${ chalk.cyan(client.user.tag) } ${ chalk.dim(`(${ client.user.id })`) } in ${ chalk.yellow(prettyMilliseconds(Date.now() - now)) }`));
		this.client.login(process.env.DISCORD_BOT_TOKEN);
		this.logger.log("Connecting to Discord...");
	}

	public static async webhook(embed: Embed, attempt = 0) {
		if (!process.env.DISCORD_WEBHOOK_URL) return;
		if (attempt > 2) return;
		const client = new Webhook(process.env.DISCORD_WEBHOOK_URL);

		embed.setFooter({
			icon_url: `https://mc-heads.net/head/${ MinecraftClient.bot.player.uuid.replace(/-/g, "") }`,
			text: MinecraftClient.bot.username
		});
		embed.setTimestamp();

		await client?.addEmbed(embed).send().catch(() => this.webhook(embed, attempt + 1));
	}

}