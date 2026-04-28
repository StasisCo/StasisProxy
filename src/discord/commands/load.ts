import { ActionRowBuilder, ChatInputCommandInteraction, EmbedBuilder, Events, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import { randomBytes } from "node:crypto";
import { DiscordManager } from "~/manager/DiscordManager";
import { prisma } from "~/prisma";

export const command = new SlashCommandBuilder()
	.setName("load")
	.setDescription("Load a stasis at a location")
	.addStringOption(option => option
		.setName("username")
		.setDescription("The Minecraft username of the stasis to load")
		.setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {

	await interaction.deferReply({ ephemeral: true });

	// Get username argument
	const username = interaction.options.getString("username");

	// Search up all connected accounts for the user, matching either username or uuid
	const accounts = await prisma.player.findMany({
		where: {
			OR: username ? [ {
				username: {
					equals: username,
					mode: "insensitive"
				}
			}, {
				id: username
			} ] : undefined,
			discords: {
				some: {
					id: interaction.user.id
				}
			}
		}
	}).catch(() => []);

	// If no accounts are found, inform the user and exit
	if (accounts.length === 0) {
		const embed = new EmbedBuilder()
			.setAuthor({
				name: interaction.user.tag,
				iconURL: interaction.user.displayAvatarURL()
			})
			.setColor(0xf43f5e)
			.setTimestamp();
		if (username) {
			embed.setTitle("No Linked Minecraft Accounts Found");
			embed.setDescription(`No Minecraft accounts linked to your Discord account match the username or UUID \`${ username }\`. Please check your spelling and try again, or use \`/connect\` to link an account if you haven't already.`);
		} else {
			embed.setTitle("No Linked Minecraft Accounts");
			embed.setDescription("You don't have any Minecraft accounts connected to your Discord account! use `/connect` to link an account before using this command.");
		}
		return void await interaction.editReply({ embeds: [ embed ]});
	}

	// Build the message components (buttons and select menus)
	const embed = new EmbedBuilder()
		.setColor(0x00c3b3);

	// Multiple accounts
	const account = await new Promise(resolve => {
		if (accounts.length > 1) {
			embed.setTitle("Select account");
			embed.setDescription("Multiple Minecraft accounts are linked to your Discord account. Please select which one you want to load.");

			const id = randomBytes(16).toString("hex");
			const component = new ActionRowBuilder().addComponents([
				new StringSelectMenuBuilder()
					.setCustomId(id)
					.setPlaceholder("Select an account")
					.addOptions(accounts.map(account => ({
						label: account.username,
						value: account.id
					})))
			]).toJSON();

			interaction.editReply({ embeds: [ embed ], components: [ component ]});

			// Wait for response from the select menu
			DiscordManager.client.on(Events.InteractionCreate, async function handler(interaction) {

				if (!interaction.isStringSelectMenu()) return;
				if (interaction.customId !== id) return;

				const account = accounts.find(account => account.id === interaction.values[0]);
				if (!account) return;

				DiscordManager.client.off(Events.InteractionCreate, handler);
			
				resolve(account);

			});

		} else resolve(accounts[0]);
	});

	embed.setDescription(`\`\`\`json\n${ JSON.stringify(account, null, 2) }\n\`\`\``);
	await interaction.editReply({ embeds: [ embed ], components: []});

	// components.push();

	// if (accounts.length === 0) {
	// 	const embed = new EmbedBuilder()
	// 		.setTitle("No Linked Minecraft Accounts")
	// 		.setDescription("You don't have any Minecraft accounts connected to your Discord account! use `/connect` to link an account before using this command.")
	// 		.setTimestamp()
	// 		.setColor(0xf43f5e);
	// 	interaction.reply({ embeds: [ embed ], flags: "Ephemeral" });
	// }
	// .setTitle(`${ owner.username } Pearled`)
	// .setThumbnail({ url: `https://mc-heads.net/head/${ owner.uuid.replace(/-/g, "") }` })
	// .addField({ name: "UUID", value: `${ owner.uuid }` })
	// .addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
	// .addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
	// .addField({ name: "Pearls", value: `${ remaining.length } / ${ STASIS_USER_MAX }` }));
	// interaction.reply({ embeds: [ embed ], components });

}
