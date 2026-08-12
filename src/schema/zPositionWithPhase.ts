import z from "zod";
import { zPosition } from "./zPosition";

export const zPositionWithPhase = zPosition.extend({
	phase: z.enum([ "standing", "sneaking", "swimming" ]),
	pitch: z.number().min(-90).max(90),
	yaw: z.number()
});
