import z from "zod";
import { zChatComponent } from "../../zChatComponent";

/**
 * A broadcast chat line. Deliberately carries NO sender: the speaker is always
 * the authenticated account behind the POST, so identity rides in the meta
 * frame's `sender` uuid rather than being restated (and trusted) in the
 * payload.
 */
export const zIrcChat = z.object({
	type: z.literal("chat"),
	message: zChatComponent
});
