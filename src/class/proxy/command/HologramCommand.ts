import { ClientCommand, type ClientCommandContext } from "../ClientCommand";
import { VALID_RENDERERS, type HologramRenderer } from "../Hologram";

/**
 * Test command exercising the {@link ClientCommandManager} pipeline end-to-end.
 * Lets a connected proxy player switch the hologram renderer at runtime:
 *
 * ```
 * /hologram body
 * /hologram head
 * /hologram text
 * ```
 */
export class HologramCommand extends ClientCommand {

	public override readonly name = "hologram";
	public override readonly description = "Switch the stasis-pearl hologram renderer";

	public override execute(args: string[], ctx: ClientCommandContext): void {
		const requested = args[0]?.toLowerCase();
		const manager = ctx.serverClient.commandManager;

		if (!requested) {
			manager.sendSystemMessage(ctx.client, `§eUsage: §7/hologram <${ VALID_RENDERERS.join("|") }>`);
			return;
		}

		if (!(VALID_RENDERERS as readonly string[]).includes(requested)) {
			manager.sendSystemMessage(ctx.client, `§cUnknown renderer §f${ requested }§c. Valid: §7${ VALID_RENDERERS.join(", ") }`);
			return;
		}

		const renderer = requested as HologramRenderer;
		ctx.serverClient.swapHologram(renderer);
		manager.sendSystemMessage(ctx.client, `§aSwitched hologram renderer to §f${ renderer }§a.`);
	}

}
