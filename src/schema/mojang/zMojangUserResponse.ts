import z from "zod";
import { zMojangUUID } from "./zUUID";
import { zMojangUsername } from "./zUsername";

export const zMojangUserResponse = z.object({
	id: zMojangUUID,
	name: zMojangUsername
});
