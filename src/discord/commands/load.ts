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
	
	const accounts = await prisma.discord.findUnique({
		where: {
			id: interaction.user.id
		},
		include: {
			players: {
				where: {
					server: Client.host,
					OR: username ? [ {
						username: username
					}, {
						uuid: username
					} ] : undefined
				},
				select: {
					uuid: true,
					username: true
				}
			}
		}
	});

	const embed = new EmbedBuilder()
		.setDescription([
			"sdf nigfdnignign nigger nigger"
		].join("\n"))
		.setColor(0x00c3b3);

	// .setTitle(`${ owner.username } Pearled`)
	// .setThumbnail({ url: `https://mc-heads.net/head/${ owner.uuid.replace(/-/g, "") }` })
	// .addField({ name: "UUID", value: `${ owner.uuid }` })
	// .addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
	// .addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
	// .addField({ name: "Pearls", value: `${ remaining.length } / ${ STASIS_USER_MAX }` }));
	interaction.reply({ embeds: [ embed ]});

}
