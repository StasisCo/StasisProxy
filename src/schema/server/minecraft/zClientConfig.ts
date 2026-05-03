import z from "zod";
import { VALID_RENDERERS } from "~/server/minecraft/Hologram";

export const zClientConfig = z.object({

	holograms: z.object({

		renderer: z.enum(VALID_RENDERERS).default("body")
        
	}).default({ renderer: "body" })

});

export type ClientConfig = z.infer<typeof zClientConfig>;