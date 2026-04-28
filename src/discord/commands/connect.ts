import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { randomBytes } from "node:crypto";
import { redis } from "~/redis";

export const command = new SlashCommandBuilder()
	.setName("connect")
	.setDescription("Connect a Minecraft account to your Discord user");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	const code = randomBytes(16).toString("base64").replace(/\/|\+|=/g, "").substring(0, 8);
	const embed = new EmbedBuilder()
		.setDescription([
			`Expires <t:${ Math.floor(Date.now() / 1000) + (60 * 5) }:R>`,
			"### Connect Your Minecraft Account",
			"Say the following code in-game to connect your Minecraft account to this Discord account:",
			"",
			`\`!connect ${ code }\``
		].join("\n"))
		.setTimestamp()
		.setColor("Blurple")
		.setAuthor({
			name: interaction.user.displayName,
			iconURL: interaction.user.displayAvatarURL()
		});
	await redis.set(`ign-link:${ code }`, interaction.user.id, "EX", 60 * 5);
	await interaction.reply({ embeds: [ embed ], flags: "Ephemeral" });
}
