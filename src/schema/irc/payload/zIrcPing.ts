import z from "zod";
import { zPosition } from "../../zPosition";

export const zIrcPing = z.object({
	type: z.literal("ping"),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
	duration: z.number().nonnegative(),
	player: z.uuid(),
	position: zPosition
});
