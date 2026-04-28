import { ChatInputCommandInteraction, Events, REST, Routes, SlashCommandBuilder } from "discord.js";
import { readdir } from "fs/promises";
import { join } from "path";
import { DiscordManager } from "~/manager/DiscordManager";

type Command = {
	command: SlashCommandBuilder;
	execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

// Dynamically import all command modules from src/commands/
const commands = new Map<string, Command>();
const commandsDir = join(__dirname, "..", "commands");
for (const file of await readdir(commandsDir)) {
	if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
	const mod: Command = await import(join(commandsDir, file));
	commands.set(mod.command.name, mod);
}

/**
 * Register slash commands with Discord when the bot is ready.
 */
DiscordManager.client.once(Events.ClientReady, async function(readyClient) {
	const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN!);
	await rest.put(Routes.applicationGuildCommands(readyClient.user.id, process.env.DISCORD_GUILD_ID!), {
		body: Array.from(commands.values()).map(c => c.command.toJSON())
	});
});

/**
 * Handle slash command interactions.
 */
DiscordManager.client.on(Events.InteractionCreate, async function(interaction) {
	if (!interaction.isChatInputCommand()) return;
	const cmd = commands.get(interaction.commandName);
	await cmd?.execute(interaction);
});
