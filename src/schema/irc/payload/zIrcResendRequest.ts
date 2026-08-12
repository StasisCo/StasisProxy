import z from "zod";

export const zIrcResendRequest = z.object({
	type: z.literal("resend_request"),
	include: z.enum([ "presence", "logout", "entity_owner" ]).array()
});

