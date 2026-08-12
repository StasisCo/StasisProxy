import z from "zod";

export const zIrcGame = z.object({
	type: z.literal("minigame"),
	game: z.string(),
	gamedata: z.any()
});