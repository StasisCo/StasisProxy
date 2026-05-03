import z from "zod";
import { HOLOGRAM_MODES } from "~/server/minecraft/Hologram";

export const zClientConfig = z.object({

	holograms: z.object({

		renderer: z.enum(HOLOGRAM_MODES).default("body")
        
	}).default({ renderer: "body" })

});

export type ClientConfig = z.infer<typeof zClientConfig>;