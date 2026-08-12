import z from "zod";

export const zPosition = z.object({
	y: z.number().min(-64),
	x: z.number().min(-30000000).max(30000000),
	z: z.number().min(-30000000).max(30000000),
	dimension: z.string().transform(a => a.toLowerCase()).pipe(z.enum([ "overworld", "nether", "end" ]))
});
