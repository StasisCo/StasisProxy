import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder, Events, SlashCommandBuilder, StringSelectMenuBuilder } from "discord.js";
import { omit } from "lodash";
import { randomBytes } from "node:crypto";
import { Client } from "~/class/Client";
import { type Player } from "~/generated/prisma/client";
import { DiscordManager } from "~/manager/DiscordManager";
import { prisma } from "~/prisma";

export const command = new SlashCommandBuilder()
	.setName("load")
	.setDescription("Load the stasis for your linked accounts")
	.addStringOption(option => option
		.setName("username")
		.setDescription("Optionally specify a Minecraft username or UUID to load the stasis for")
		.setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {

	// Start thinking
	await interaction.deferReply({ flags: "Ephemeral" });

	// Build the message components (buttons and select menus)
	const embed = new EmbedBuilder()
		.setColor(0x00c3b3)
		.setTimestamp()
		.setFooter({
			text: interaction.user.displayName,
			iconURL: interaction.user.displayAvatarURL()
		});

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
		embed.setColor(0xf43f5e);
		embed.setTimestamp();
		if (username) {
			embed.setTitle("No Linked Minecraft Accounts Found");
			embed.setDescription(`No Minecraft accounts linked to your Discord account match the username or UUID \`${ username }\`. Please check your spelling and try again, or use \`/connect\` to link an account if you haven't already.`);
		} else {
			embed.setTitle("No Linked Minecraft Accounts");
			embed.setDescription("You don't have any Minecraft accounts connected to your Discord account! use `/connect` to link an account before using this command.");
		}
		return void await interaction.editReply({ embeds: [ embed ]});
	}

	// Multiple accounts
	const account = await new Promise<Player>(resolve => {

		// If only one account is found, select it automatically
		if (accounts.length === 1 && accounts[0]) return resolve(accounts[0]);

		// Otherwise, ask the user to select an account from a dropdown menu
		embed.setTitle("Select Account");
		embed.setDescription("Multiple Minecraft accounts are linked to your Discord account. Please select which one you want to load.");

		// Generate a random ID for the select menu to avoid conflicts with other commands
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

		// Send the message with the select menu
		interaction.editReply({ embeds: [ embed ], components: [ component ]});

		// Wait for response from the select menu
		DiscordManager.client.on(Events.InteractionCreate, async function handler(interaction) {

			if (!interaction.isStringSelectMenu()) return;
			if (interaction.customId !== id) return;

			// Acknowledge the component interaction to stop the loading spinner
			await interaction.deferUpdate();

			// Find the selected account from the list of accounts
			const account = accounts.find(account => account.id === interaction.values[0]);
			if (!account) return DiscordManager.client.off(Events.InteractionCreate, handler);

			DiscordManager.client.off(Events.InteractionCreate, handler);
			resolve(account);

		});

	});

	// Get all stasis pearls owned by the selected account that are currently loaded in the bot
	const allPearls = await prisma.stasis.findMany({
		where: {
			ownerId: account.id,
			botId: {
				not: null
			}
		},
		select: {
			id: true,
			owner: true,
			bot: {
				include: {
					player: {
						select: {
							id: true,
							username: true
						}
					}
				}
			}
		}
	})
		.then(pearls => pearls.filter(pearl => Object.values(Client.bot.players).some(player => player.uuid === pearl.owner.id)))
		.catch(() => []);
		
	// List all the bots this account has pearls at
	const bots = allPearls.map(pearl => pearl.bot)
		.filter((bot, index, self) => bot && self.findIndex(b => b?.id === bot.id) === index)
		.map(bot => bot?.player)
		.filter(player => player)
		.map(player => player as Exclude<typeof player, undefined>);
		
	// Group pearls by bot
	const byBot = new Map<string, Set<typeof allPearls[number]>>();
	for (const pearl of allPearls) {
		if (!pearl.bot) continue;
		byBot.getOrInsert(pearl.bot.id, new Set()).add(pearl);
	}

	if (bots.length === 0) {
		embed.setTitle("No Stasis");
		embed.setDescription("You don't have any stasis in range of a bot.");
		return void await interaction.editReply({ embeds: [ embed ]});
	}

	// If only one bot is found, select it automatically, otherwise ask the user to select a bot from a dropdown menu
	const bot = await new Promise<typeof bots[number]>(resolve => {

		// If the account only has pearls at one bot, select it automatically
		if (bots.length === 1 && bots[0]) return resolve(bots[0]);

		// Otherwise, ask the user to select a bot from a dropdown menu
		embed.setTitle("Select Location");
		embed.setDescription("You have stasis at multiple locations. Please select which location you want to load.");

		const id = randomBytes(16).toString("hex");
		const component = new ActionRowBuilder().addComponents([
			new StringSelectMenuBuilder()
				.setCustomId(id)
				.setPlaceholder("Select location")
				.addOptions(bots.sort((a, b) => a.username.localeCompare(b.username)).map(bot => ({
					label: bot.username,
					description: `${ byBot.get(bot.id)?.size ?? 0 } pearl${ byBot.get(bot.id)?.size === 1 ? "" : "s" }`,
					value: bot.id
				})))
		]).toJSON();
		
		// Send the message with the select menu
		interaction.editReply({ embeds: [ embed ], components: [ component ]});

		// Wait for response from the select menu
		DiscordManager.client.on(Events.InteractionCreate, async function handler(interaction) {

			if (!interaction.isStringSelectMenu()) return;
			if (interaction.customId !== id) return;

			// Acknowledge the component interaction to stop the loading spinner
			await interaction.deferUpdate();

			// Find the selected bot from the list of bots
			const bot = bots.find(bot => bot.id === interaction.values[0]);
			if (!bot) return DiscordManager.client.off(Events.InteractionCreate, handler);

			DiscordManager.client.off(Events.InteractionCreate, handler);
			resolve(bot);

		});

	});

	const pearls = byBot.get(bot.id)?.values().toArray().map(pearl => omit(pearl, "bot", "owner")) ?? [];
	if (pearls.length === 0) return;

	embed.setAuthor({
		name: bot.username,
		iconURL: `https://mc-heads.net/head/${ bot.id.replace(/-/g, "") }`
	});

	embed.setTitle(`Load Stasis for ${ account.username }`);
	embed.setDescription(null);

	const components = [
		new ActionRowBuilder().addComponents(

			new ButtonBuilder()
				.setCustomId(`loadnow:${ account.id }:${ bot.id }`)
				.setLabel("Load Now")
				.setStyle(ButtonStyle.Primary),

			new ButtonBuilder()
				.setCustomId(`instantpearl:${ account.id }:${ bot.id }`)
				.setLabel("Instant Pearl")
				.setStyle(ButtonStyle.Primary)
				
		).toJSON()
			
	];

	return void await interaction.editReply({ embeds: [ embed ], components });

}
