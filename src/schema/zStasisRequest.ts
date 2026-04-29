import z from "zod";

export const zStasisRequest = z.object({
	type: z.literal("load"),
	player: z.uuid(),
	status: z.string()
});