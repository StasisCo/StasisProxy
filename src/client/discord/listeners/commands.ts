import { ChatInputCommandInteraction, Events, REST, Routes, SlashCommandBuilder } from "discord.js";
import { readdir } from "fs/promises";
import { join } from "path";
import { DiscordClient } from "~/client/discord/DiscordClient";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { redis } from "~/redis";

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
 *
 * Multiple containers share one bot token, so every container opens its own
 * gateway session and Discord registers commands once per ready event. We
 * coordinate via Redis so only one container performs the REST registration
 * per startup window — otherwise we hit the global app-command rate limit.
 */
DiscordClient.client.once(Events.ClientReady, async function(readyClient) {
	const claim = await redis.set("stasisproxy:discord:register", true, "EX", "60", "NX");
	if (claim !== "OK") return;
	const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN!);
	await rest.put(Routes.applicationCommands(readyClient.user.id), {
		body: Array.from(commands.values()).map(c => c.command.toJSON())
	});
});

/**
 * Handle slash command interactions.
 *
 * Every container with the same bot token receives every interaction. We claim
 * the interaction id in Redis with SET NX EX — exactly one container wins and
 * executes the command. The rest silently bail. Without this every container
 * tries to `reply()` and all but one crash with `10062 Unknown interaction`.
 */
DiscordClient.client.on(Events.InteractionCreate, async function(interaction) {
	if (!interaction.isChatInputCommand()) return;
	const cmd = commands.get(interaction.commandName);
	if (!cmd) return;

	// Claim ownership of this interaction. The claim value names the winning container and its
	// code version, so a bad answer can be traced to the container that produced it (old builds
	// wrote `true` here — an anonymous claim means an outdated container won). TTL matches the
	// 15-minute interaction token lifetime to leave a forensic window.
	const claim = await redis.set(`stasisproxy:discord:interaction:${ interaction.id }`, MinecraftClient.userAgent + ":" + (MinecraftClient.options.username ?? "unknown"), "EX", "900", "NX");
	if (claim !== "OK") return;

	try {
		await cmd.execute(interaction);
	} catch (err) {

		// Swallow `Unknown interaction` (10062) and `Interaction has already been acknowledged` (40060)
		// in case the claim race somehow lets two through (e.g. brief Redis blip).
		const code = (err as { code?: number }).code;
		if (code === 10062 || code === 40060) return;
	}
});
