import z from "zod";
import { zPlayer } from "../../zPlayer";
import { zPosition } from "../../zPosition";

export const zIrcDeath = z.object({
	type: z.literal("death"),

	// A third party, so the full object — deaths are reported by whoever
	// witnessed them, not by the player who died. See zIrcEntityOwner for the
	// shape rule.
	player: zPlayer,
	pops: z.number().int().nonnegative(),
	timestamp: z.number().int().nonnegative(),
	position: zPosition
});
