import type { Request } from "express";
import stringify from "fast-json-stable-stringify";
import { prisma } from "~/prisma";
import { zMojangAccessToken } from "~/schema/mojang/zMojangAccessToken";

export async function resolvePlayer(request: Request) {

	// Check for a valid Authorization header
	if (typeof request.headers !== "object" || !request.headers || Array.isArray(request.headers) || typeof request.headers.authorization !== "string") {
		return new Response(stringify({
			success: false,
			message: "Missing or invalid authorization header"
		}), {
			status: 401,
			headers: { "Content-Type": "application/json" }
		});
	}

	// Authenticate with Mojang and get the users profile
	const accessToken = request.headers.authorization.replace(/^Bearer\s+/, "").trim();
	const { data, success } = await zMojangAccessToken.safeParseAsync(accessToken);
	if (!success) return new Response(stringify({
		success: false,
		message: "Invalid access token"
	}), {
		status: 401,
		headers: { "Content-Type": "application/json" }
	});

	// Upsert the player record in the database and return it
	return await prisma.player.upsert({
		where: {
			id: data.id
		},
		create: {
			id: data.id,
			username: data.name
		},
		update: {
			username: data.name
		}
	});

}
