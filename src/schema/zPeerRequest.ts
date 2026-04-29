import z from "zod";
import { zStasisRequest } from "./zStasisRequest";

export const zPeerRequest = z.union([
	zStasisRequest
]);