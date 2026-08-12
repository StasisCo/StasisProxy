import type { Command } from "commander";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { ChatCommandManager } from "~/client/minecraft/manager/ChatCommandManager";

export default function(program: Command) {
	program
		.command("exit")
		.description("Disconnect the bot — non-zero codes restart via reconnect, 0 shuts down cleanly")
		.argument("[code]", "Exit code (0 = clean shutdown, anything else restarts)", "1")
		.action(async(codeArg: string) => {

			const { player } = ChatCommandManager.context;

			const sender = MinecraftClient.bot.players[player.username];
			if (!sender) return;
			if (!await ChatCommandManager.isWhitelisted(sender)) return;

			const code = Number.parseInt(codeArg, 10);
			if (!Number.isInteger(code) || code < 0 || code > 255) {
				throw new Error("Exit code must be an integer between 0 and 255.");
			}

			MinecraftClient.chat.whisper(sender, code === 0 ? "Shutting down (exit 0)." : `Restarting (exit ${ code }).`);

			// Give the acknowledgement a moment to flush before tearing the connection down.
			setTimeout(() => MinecraftClient.exit(code), 1_000);

		});

}
