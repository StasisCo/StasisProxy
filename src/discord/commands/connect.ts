import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import stringify from "fast-json-stable-stringify";
import { randomBytes } from "node:crypto";
import { redis } from "~/redis";

export const command = new SlashCommandBuilder()
	.setName("connect")
	.setDescription("Connect a Minecraft account to your Discord user");
	
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const timeInSeconds = 60 * 5;
	const code = randomBytes(16).toString("base64").replace(/\/|\+|=/g, "").substring(0, 8);
	const embed = new EmbedBuilder()
		.setTitle("Connect Your Minecraft Account")
		.setDescription([
			"Say the following code in-game to connect your Minecraft account to this Discord account:",
			"```",
			`!connect ${ code }`,
			"```",
			"If `!connect` is chat-filtered, try using `!link` or whispering any bot instead.",
			"",
			`Expires <t:${ Math.floor(Date.now() / 1000) + timeInSeconds }:R>`
		].join("\n"))
		.setColor("Blurple")
		.setTimestamp()
		.setFooter({
			text: interaction.user.displayName,
			iconURL: interaction.user.displayAvatarURL()
		});
	await redis.set(`ign-link:${ code }:user`, stringify(interaction.user.toJSON()), "EX", timeInSeconds);
	await interaction.reply({ embeds: [ embed ], flags: "Ephemeral" });
	await redis.set(`ign-link:${ code }:message`, stringify({
		type: "interaction-original",
		applicationId: interaction.applicationId,
		token: interaction.token
	}), "EX", timeInSeconds);
	setTimeout(() => void interaction.deleteReply().catch(() => {}), timeInSeconds * 1000);
}

