import z from "zod";

export const zIrcKeepalive = z.object({
	type: z.literal("keepalive")
});
