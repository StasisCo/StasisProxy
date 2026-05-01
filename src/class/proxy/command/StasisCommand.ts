import { ClientCommand, type ClientCommandContext } from "../ClientCommand";

/**
 * `/stasis` — open a chest GUI showing one player head per unique owner of a
 * stasis currently tracked within render distance of the bot. The GUI is
 * rendered entirely client-side by the proxy; clicks are swallowed so the
 * upstream server never sees the synthetic window.
 */
export class StasisCommand extends ClientCommand {

	public override readonly name = "stasis";
	public override readonly description = "List players with stasis chambers in render distance";

	public override async execute(_args: string[], ctx: ClientCommandContext): Promise<void> {
		await ctx.serverClient.openStasisListGui();
	}

}
