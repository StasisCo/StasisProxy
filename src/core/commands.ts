import { Glob } from "bun";
import chalk from "chalk";
import { type Bot as BotType, type Player } from "mineflayer";
import z from "zod";
import { prisma } from "..";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { COMMAND_CHAT_DISABLED, COMMAND_CHAT_PREFIX, COMMAND_PERMISSION_CHECKS_DISABLED } from "../config";
import { formatPlayer, printObject } from "../utils/format";

const zModule = z.object({
	aliases: z.string().array().min(1),
	default: z.function({
		input: z.tuple([
			z.custom<Player>(),
			z.string().array()
		]),
		output: z.promise(z.string().or(z.undefined()))
	}),
	admin: z.boolean().optional().default(false)
});

/**
 * Module to handle chat commands for the bot
 * @param bot The bot instance
 */
export default async function(bot: BotType) {
	
	// Load core modules and modules
	const commands: z.infer<typeof zModule>[] = [];
	for await (const path of new Glob("src/{commands}/**/*.ts").scan()) {
		await import(`../../${ path }`)
			.then(zModule.parseAsync)
			.then(module => commands.push(module));
	}

	/**
	 * Handle commands from public chat with a specific prefix
	 */
	bot.on("chat", async function(username, message) {
		if (COMMAND_CHAT_DISABLED) return;
		if (!message.startsWith(COMMAND_CHAT_PREFIX)) return;
		const command = message.substring(COMMAND_CHAT_PREFIX.length).split(" ")[0]?.toLowerCase();
		const args = message.split(" ").slice(1);
		const sender = bot.players[username];
		if (!sender || !sender.uuid || !command) return;
		const resp = await exec(sender, command, args);
		if (typeof resp === "string") bot.chat(resp);
	});
	
	/**
	 * Handle commands from private messages (whispers)
	 */
	bot.on("whisper", async function(username, message) {
		const command = message.split(" ")[0]?.toLowerCase();
		const args = message.split(" ").slice(1);
		const sender = bot.players[username];
		if (!sender || !sender.uuid || !command) return;
		const resp = await exec(sender, command, args);
		if (typeof resp === "string") bot.chat(`/msg ${ username } ${ resp }`);
	});

	/**
	 * Execute a command
	 * @param player - The player who sent the command
	 * @param cmd - The command to execute
	 * @param args - The arguments for the command
	 */
	async function exec(player: Player, cmd: string, args: string[]) {

		Logger.log("Command received:");
		printObject({
			from: formatPlayer(player),
			command: cmd,
			arguments: args.length > 0 ? args.join(" ") : chalk.gray("(none)")
		});

		const command = commands.find(c => c.aliases.includes(cmd));
		if (!command) return;

		// Get the player's permissions from the database
		const dbPlayer = await prisma.players.findUnique({
			where: {
				observer_server_uuid_unique: {
					observer: bot.player.uuid,
					server: Bot.server,
					uuid: player.uuid
				}
			}
		});

		if (command.admin && !dbPlayer?.admin && !COMMAND_PERMISSION_CHECKS_DISABLED) {
			Logger.warn("Permission denied:");
			printObject({
				from: formatPlayer(player),
				command: cmd,
				reason: "Insufficient permissions"
			});
			return "You do not have permission to use this command.";
		}

		// Execute the command
		return await command.default(player, args);

	}
	
};