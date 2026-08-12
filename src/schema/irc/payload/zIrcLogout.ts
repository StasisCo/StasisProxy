import z from "zod";
import { zInventorySlot } from "../../zInventorySlot";
import { zPlayer } from "../../zPlayer";
import { zPositionWithPhase } from "../../zPositionWithPhase";

export const zIrcLogout = z.object({
	type: z.literal("logout"),
	inventory: z.array(zInventorySlot).max(6),

	// A third party, so the full object — the observed player who left, named
	// by whoever saw them go (they cannot broadcast their own logout). See
	// zIrcEntityOwner for the shape rule.
	player: zPlayer,
	pops: z.number().int().nonnegative(),
	timestamp: z.number().int().nonnegative(),
	position: zPositionWithPhase
});
