import z from "zod";
import { zChatComponent } from "../../zChatComponent";

/**
 * A direct message: chat addressed to exactly one player, filtered server-side
 * at delivery so nobody else is ever sent it. Like zIrcChat the sender is the
 * authenticated account, named by the meta frame — the payload only names the
 * RECIPIENT.
 */
export const zIrcMessage = z.object({
	type: z.literal("message"),
	message: zChatComponent,
	to: z.uuid()
});
