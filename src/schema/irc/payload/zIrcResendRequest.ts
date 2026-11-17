import z from "zod";

export const zIrcResendRequest = z.object({
	type: z.literal("resend_request"),
	include: z.enum([ "presence", "logout", "entity_owner" ]).array(),

	// The entities an `entity_owner` resend asks about, by the same id an
	// entity_owner payload carries. Peers answer only for the ones whose owner
	// they know, so a request without ids gets no entity owners back. Bounded,
	// since the client groups every entity it saw in a 15 s window into one.
	ids: z.string().max(64).array().max(512).optional()
});

