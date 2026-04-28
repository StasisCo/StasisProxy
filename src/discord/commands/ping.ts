import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";

export const command = new SlashCommandBuilder()
	.setName("ping")
	.setDescription("Show bot heartbeat and interaction latency.");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
	await interaction.reply({ content: "pong", ephemeral: true });
}
