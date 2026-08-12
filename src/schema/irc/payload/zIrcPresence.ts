import z from "zod";
import { zInventorySlot } from "../../zInventorySlot";

/**
 * A presence snapshot describes the SENDER, so like zIrcChat it carries no
 * player at all — identity rides in the meta frame's `uuid`, and
 * delivery coalescing keys on that.
 */
export const zIrcPresence = z.object({
	type: z.literal("presence"),
	inventory: z.array(zInventorySlot),
	attributes: z.object({
		absorption: z.number(),
		health: z.number(),
		hunger: z.number(),
		oxygen: z.number(),
		saturation: z.number()
	})
});
