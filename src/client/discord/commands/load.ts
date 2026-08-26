import { randomBytes } from "crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, EmbedBuilder, Events, SlashCommandBuilder, StringSelectMenuBuilder, type ButtonInteraction, type CacheType } from "discord.js";
import type { Player } from "~/generated/prisma/client";
import { prisma } from "~/prisma";
import { redis } from "~/redis";
import { DiscordClient } from "../DiscordClient";

export const command = new SlashCommandBuilder()
	.setName("load")
	.setDescription("Load the stasis for your linked accounts")
	.addStringOption(option => option
		.setName("username")
		.setDescription("Optionally specify a Minecraft username or UUID to load the stasis for")
		.setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {

	// Start thinking
	const id = randomBytes(16).toString("hex");
	await interaction.deferReply({ flags: "Ephemeral" });

	// Build the message components (buttons and select menus)
	const embed = new EmbedBuilder()
		.setTimestamp()
		.setFooter({
			iconURL: interaction.user.displayAvatarURL(),
			text: interaction.user.displayName
		});

	// Get username argument
	const username = interaction.options.getString("username");

	// Search up all connected accounts for the user, matching either username or uuid
	const accounts = await prisma.player.findMany({ where: { OR: username ? [ { username: { equals: username, mode: "insensitive" }}, { id: username } ] : undefined, discords: { some: { id: interaction.user.id }}}}).catch(() => []);

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
		await interaction.editReply({ embeds: [ embed ]});
		return;
	}

	// Get the account to load. If there are multiple accounts, ask the user to select one
	const account = await new Promise<Player>(resolve => {

		// If only one account is found, select it automatically
		if (accounts[0] && accounts.length === 1) return resolve(accounts[0]);

		// Generate a random ID for the select menu to avoid conflicts with other commands
		const component = new ActionRowBuilder().addComponents([
			new StringSelectMenuBuilder()
				.setCustomId(`${ id }:account`)
				.setPlaceholder("Select an account to load")
				.addOptions(accounts.map(account => ({
					label: account.username,
					value: account.id
				})))
		]).toJSON();
		
		// Update embed to prompt the user to select an account
		embed
			.setColor(0x00c3b3)
			.setTitle("Select Account")
			.setDescription(null);

		// Send the message with the select menu
		interaction.editReply({ embeds: [ embed ], components: [ component ]});

		// Wait for response from the select menu
		DiscordClient.client.on(Events.InteractionCreate, async function handler(interaction) {

			if (!interaction.isStringSelectMenu()) return;
			if (interaction.customId !== `${ id }:account`) return;

			// Acknowledge the component interaction to stop the loading spinner
			await interaction.deferUpdate();

			// Find the selected account from the list of accounts
			const account = accounts.find(account => account.id === interaction.values[0]);
			if (!account) return DiscordClient.client.off(Events.InteractionCreate, handler);

			DiscordClient.client.off(Events.InteractionCreate, handler);
			resolve(account);

		});

	});

	// Get all pearls for this account that have at least one managing bot
	const pearls = await prisma.stasis.findMany({ where: { ownerId: account.id, managers: { some: {}}}, select: { id: true, owner: true, managers: { include: { player: { select: { id: true, username: true }}}}}})
		.catch(err => {
			DiscordClient.logger.error("Failed to fetch stasis for /load:", err);
			return [];
		});

	// Resolve which manager bots are online, and on which server, from their cluster-wide presence
	// heartbeats. This container's own tab list can't answer that — an arbitrary container wins the
	// interaction claim, including one that is queueing or reconnecting and sees no peers at all.
	const online = new Map<string, string>();
	await Promise.all(Array.from(new Set(pearls.flatMap(pearl => pearl.managers.map(manager => manager.id))), async managerId => {
		const presence = await redis.get(`stasisproxy:bot:online:${ managerId }`);
		if (presence) online.set(managerId, presence.host);
	}));

	// Keep only pearls with an online manager
	const all = pearls.filter(pearl => pearl.managers.some(manager => online.has(manager.id)));

	// Get the unique online bots that have pearls for this account
	const bots = new Map();
	for (const pearl of all) for (const manager of pearl.managers) if (online.has(manager.id)) bots.set(manager.id, manager.player);

	// If no pearls are found, inform the user and exit
	if (all.length === 0) {
		embed.setColor(0xf43f5e);
		embed.setTitle("No Stasis Found");
		embed.setDescription(`No stasis found for account ${ account.username } that is in range of any online bot. Make sure you have a stasis set up and that a bot is within range, then try again.`);
		await interaction.editReply({ embeds: [ embed ]});
		return;
	}

	// Group pearls by online bot
	const byBot = new Map<string, Set<typeof all[number]>>();
	for (const pearl of all) for (const manager of pearl.managers) if (online.has(manager.id)) byBot.getOrInsert(manager.id, new Set()).add(pearl);

	// Get the bot to request to load. If there is only one bot, select it automatically, otherwise ask the user to select a bot from a dropdown menu
	const bot = await new Promise<Player>(resolve => {

		// If only one bot is found, select it automatically
		if (bots.size === 1) return resolve(bots.values().next().value);

		// Generate a random ID for the select menu to avoid conflicts with other commands
		const component = new ActionRowBuilder().addComponents([
			new StringSelectMenuBuilder()
				.setCustomId(`${ id }:bot`)
				.setPlaceholder("Select a bot to load from")
				.addOptions(bots.values().toArray().map(account => ({
					label: account.username,
					description: `${ byBot.get(account.id)?.size ?? 0 } pearl${ byBot.get(account.id)?.size === 1 ? "" : "s" }`,
					value: account.id
				})))
		]).toJSON();

		// Update embed to prompt the user to select a bot
		embed
			.setColor(0x00c3b3)
			.setTitle("Select Location")
			.setDescription(null);

		// Send the message with the select menu
		interaction.editReply({ embeds: [ embed ], components: [ component ]});

		// Wait for response from the select menu
		DiscordClient.client.on(Events.InteractionCreate, async function handler(interaction) {

			if (!interaction.isStringSelectMenu()) return;
			if (interaction.customId !== `${ id }:bot`) return;

			// Acknowledge the component interaction to stop the loading spinner
			await interaction.deferUpdate();

			// Find the selected bot from the map of bots
			const selected = bots.get(interaction.values[0]);
			if (!selected) return DiscordClient.client.off(Events.InteractionCreate, handler);

			DiscordClient.client.off(Events.InteractionCreate, handler);
			resolve(selected);

		});

	});

	// Update embed to show loading state
	embed
		.setColor(0x00c3b3)
		.setTitle("Load Stasis")
		.setDescription(null);

	const components = [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`${ id }:load`)
				.setLabel("Load Stasis")
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`${ id }:cancel`)
				.setLabel("Abort Stasis")
				.setStyle(ButtonStyle.Danger)
		).toJSON()
	];

	interaction.editReply({ embeds: [ embed ], components });

	// On interaction with the buttons, either load the stasis or instant pearl it
	DiscordClient.client.on(Events.InteractionCreate, async function handler(interaction) {

		// Check if the interaction is from the buttons we sent
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith(id)) return;
		await interaction.deferUpdate();

		// Get the action from the custom ID of the button
		const [ _, request ] = interaction.customId.split(":");
		switch (request) {

			case "cancel":
				DiscordClient.client.off(Events.InteractionCreate, handler);
				await interaction.deleteReply();
				return;

			case "load": {
				loadAndLifeCycle(interaction, bot, account, id);
				break;
			}

		}
		
	});

}

async function loadAndLifeCycle(interaction: ButtonInteraction<CacheType>, bot: Player, account: Player, id: string) {

	const embed = new EmbedBuilder();
	embed.setAuthor({ name: bot.username, iconURL: `https://mc-heads.net/head/${ bot.id }` });

	// Re-check the bot's presence at press time — it may have gone offline since the pearls were
	// listed, and its heartbeat carries the server host the load request must be routed to.
	const presence = await redis.get(`stasisproxy:bot:online:${ bot.id }`);
	if (!presence) {
		embed.setColor(0xf43f5e);
		embed.setTitle("Bot Offline");
		embed.setDescription(`**${ bot.username }** is no longer online, please try again later...`);
		await interaction.editReply({ embeds: [ embed ], components: []});
		return;
	}

	embed.setColor(0xeab308);
	embed.setTitle("Traveling to Stasis");
	embed.setDescription(`**${ bot.username }** is traveling to your stasis, please wait...`);

	await interaction.editReply({ embeds: [ embed ], components: []});

	// Publish a load request to the bot's cluster channel
	const expire = 75 * 1000;

	// Subscribe to status updates BEFORE emitting the request to avoid missing early statuses
	await redis.on(`stasisproxy:stasis:status:${ id }`, async data => {
		switch (data) {

			case "arrived":
				embed.setColor(0x22c55e);
				embed.setTitle("Ready to Load");
				embed.setDescription(`Aborting automatically <t:${ Math.floor((Date.now() + expire) / 1000) }:R>. Log in to be pearled immediately.`);
				await interaction.editReply({ embeds: [ embed ]});
				break;

			case "succeeded":
				embed.setColor(0x22c55e);
				embed.setTitle("Stasis Loaded");
				embed.setDescription(`**${ bot.username }** has successfully loaded your stasis.`);
				await interaction.editReply({ embeds: [ embed ]});
				redis.off(`stasisproxy:stasis:status:${ id }`);
				break;

			case "failed":
				embed.setColor(0xf43f5e);
				embed.setTitle("Stasis Failed");
				embed.setDescription(`**${ bot.username }** failed to load your stasis, please try again...`);
				await interaction.editReply({ embeds: [ embed ]});
				redis.off(`stasisproxy:stasis:status:${ id }`);
				break;

			case "timed-out":
				embed.setColor(0xf43f5e);
				embed.setTitle("Timed Out Waiting for Login");
				embed.setDescription(`**${ account.username }** didn't log in within the time limit, please try again...`);
				await interaction.editReply({ embeds: [ embed ]});
				redis.off(`stasisproxy:stasis:status:${ id }`);
				break;

		}

	});

	// Now emit the load request — the subscription above is already active. Route to the manager
	// bot's own server channel, not this container's, which may not even be connected.
	await redis.emit(`stasisproxy:cluster:${ presence.host }`, {
		type: "request-load",
		playerUuid: account.id,
		destinationUuid: bot.id,
		statusKey: `stasisproxy:stasis:status:${ id }`
	});

}