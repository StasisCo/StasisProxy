import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { Client } from "~/class/Client";
import { prisma } from "~/prisma";

export const command = new SlashCommandBuilder()
	.setName("load")
	.setDescription("Load a stasis at a location")
	.addStringOption(option => option
		.setName("username")
		.setDescription("The Minecraft username of the stasis to load")
		.setRequired(false))
	.addStringOption(option => option
		.setName("location")
		.setDescription("The location of the stasis to load")
		.setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {

	const username = interaction.options.getString("username");
	const location = interaction.options.getString("location");

	const accounts = await prisma.player.findMany({
		where: {
			server: Client.host,
			OR: username ? [ {
				username: username
			}, {
				uuid: username
			} ] : undefined,
			discords: {
				some: {
					id: interaction.user.id
				}
			}
		}
	}).catch(() => []);

	// const embed = new EmbedBuilder()
	// 	.setColor(0x00c3b3);

	if (accounts.length === 0) {
		const embed = new EmbedBuilder()
			.setTitle("No Linked Minecraft Accounts")
			.setDescription("You don't have any Minecraft accounts connected to your Discord account! use `/connect` to link an account before using this command.")
			.setTimestamp()
			.setColor(0xf43f5e);
		interaction.reply({ embeds: [ embed ], flags: "Ephemeral" });
	}

	// .setTitle(`${ owner.username } Pearled`)
	// .setThumbnail({ url: `https://mc-heads.net/head/${ owner.uuid.replace(/-/g, "") }` })
	// .addField({ name: "UUID", value: `${ owner.uuid }` })
	// .addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
	// .addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
	// .addField({ name: "Pearls", value: `${ remaining.length } / ${ STASIS_USER_MAX }` }));
	// interaction.reply({ embeds: [ embed ]});

}
