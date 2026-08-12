import z from "zod";
import { zMojangUsername } from "./mojang/zUsername";

export const zPlayer = z.object({
	uuid: z.uuid(),
	name: zMojangUsername
});