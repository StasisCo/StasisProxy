import z from "zod";
import { zPlayer } from "../../zPlayer";

export const zIrcLogin = z.object({
	type: z.literal("login"),

	// A third party, so the full object — a login announces that a player WITH
	// A LOGOUT SPOT rejoined, observed and named by someone else. See
	// zIrcEntityOwner for the shape rule.
	player: zPlayer,
	timestamp: z.number().int().nonnegative()
});
