import type { Command } from "commander";
import { ClientCommandManager } from "~/server/minecraft/ClientCommandManager";
import { VALID_RENDERERS, type HologramRenderer } from "~/server/minecraft/Hologram";

export const completions = [ [ ...VALID_RENDERERS ] ];

export default function(program: Command) {
	program
		.command("hologram")
		.description("Switch the stasis-pearl hologram renderer")
		.argument("[renderer]", "The renderer to use")
		.action((renderer?: string) => {
			const { client, serverClient } = ClientCommandManager.context;
			const requested = renderer?.toLowerCase();

			if (!requested) {
				ClientCommandManager.sendSystemMessage(client, `§eUsage: §7/hologram <${ VALID_RENDERERS.join("|") }>`);
				return;
			}

			if (!(VALID_RENDERERS as readonly string[]).includes(requested)) {
				ClientCommandManager.sendSystemMessage(client, `§cUnknown renderer §f${ requested }§c. Valid: §7${ VALID_RENDERERS.join(", ") }`);
				return;
			}

			serverClient.swapHologram(requested as HologramRenderer);
			ClientCommandManager.sendSystemMessage(client, `§aSwitched hologram renderer to §f${ requested }§a.`);
		});
}
