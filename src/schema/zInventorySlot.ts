import z from "zod";
import { zItemStack } from "./zItemStack";

export const zInventorySlot = z.object({
	slot: z.number().int().nonnegative(),
	item: zItemStack
});
