import z from "zod";

export const zMojangAPIErrorResponse = z.object({
	error: z.string(),
	errorMessage: z.string(),
	path: z.string().optional()
});
