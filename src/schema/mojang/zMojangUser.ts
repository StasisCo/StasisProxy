import z from "zod";
import { zMojangUsername } from "./zUsername";

export const zMojangUser = z.object({
	id: z.string().transform(id => id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")),
	name: zMojangUsername,
	capes: z.object({
		id: z.uuid(),
		state: z.string(),
		url: z.url(),
		alias: z.string().optional().nullable()
	}).array(),
	skins: z.object({
		id: z.uuid(),
		state: z.string(),
		url: z.url(),
		variant: z.string(),
		alias: z.string().optional().nullable()
	}).array()
});
