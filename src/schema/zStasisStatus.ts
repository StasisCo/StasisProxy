import z from "zod";

export const zStasisStatus = z.enum([
	"arrived",
	"failed",
	"queued",
	"succeeded",
	"timed-out"
]);