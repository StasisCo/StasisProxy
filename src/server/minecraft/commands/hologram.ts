import type { Command } from "commander";
import z from "zod";
import { ClientCommands } from "~/server/minecraft/ClientCommands";
import { HOLOGRAM_MODES } from "~/server/minecraft/Hologram";

export const completions = [ HOLOGRAM_MODES ];

export default function(program: Command) {
	program
		.command("hologram")
		.usage(`<${ completions.join("|") }>`)
		.description("Switch the hologram renderer")
		.argument("<renderer>", `The renderer to use (${ HOLOGRAM_MODES.join(", ") })`)
		.action(function(renderer: string) {

			// This command is only relevant in the context of a connected player
			if (!ClientCommands.hasContext) return ClientCommands.error("This command can only be used in-game.");

			// Validate the requested renderer against the known modes.
			const { data, success } = z.enum(HOLOGRAM_MODES).safeParse(renderer.toLowerCase());
			if (!success) return ClientCommands.usage(this);

			// Swap the hologram renderer and confirm.
			ClientCommands.reply(`§3Hologram renderer switched to §b${ data }§3.`);
			ClientCommands.context.serverClient.swapHologram(data);

		});
}
