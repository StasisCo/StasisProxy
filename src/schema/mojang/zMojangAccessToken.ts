import { createHash } from "crypto";
import z from "zod";
import { redis } from "../../redis";
import { zMojangAPIErrorResponse } from "./zMojangAPIErrorResponse";
import { zMojangUser } from "./zMojangUser";

const inFlightByToken = new Map<string, Promise<z.infer<typeof zMojangUser>>>();

export const zMojangAccessToken = z.string().transform(async(authorization, ctx) => {

	const hash = createHash("sha256").update(authorization).digest("hex");

	try {
		const cached = await redis.get(`stasisproxy:mcacache:${ hash }`);
		if (cached) {
			const parsedCache = await zMojangUser.safeParseAsync(cached);
			if (parsedCache.success) return parsedCache.data;
		}
	} catch {

		// Cache is best-effort; continue to live lookup on failure
	}

	const lookup = async() => {
		const req = await fetch("https://api.minecraftservices.com/minecraft/profile", {
			headers: {
				authorization: `Bearer ${ authorization.split(" ").pop() }`
			}
		});
		const parsed = await req.json().then(z.union([ zMojangUser, zMojangAPIErrorResponse ]).safeParseAsync);

		if (!parsed.success || "error" in parsed.data) {
			const message = parsed.success && "error" in parsed.data
				? parsed.data.errorMessage
				: "Invalid Minecraft access token response.";
			throw new Error(message);
		}

		const profile = zMojangUser.parse(parsed.data);
		try {
			await redis.set(`stasisproxy:mcacache:${ hash }`, profile, "EX", "604800");
		} catch {

			// Cache is best-effort; ignore write failures
		}
		return profile;
	};

	let inFlight = inFlightByToken.get(`stasisproxy:mcacache:${ hash }`);
	if (!inFlight) {
		inFlight = lookup().finally(() => inFlightByToken.delete(`stasisproxy:mcacache:${ hash }`));
		inFlightByToken.set(`stasisproxy:mcacache:${ hash }`, inFlight);
	}

	try {
		return await inFlight;
	} catch (error) {
		ctx.addIssue({
			code: "custom",
			message: error instanceof Error ? error.message : "Invalid Minecraft access token response."
		});
		return z.NEVER;
	}

});