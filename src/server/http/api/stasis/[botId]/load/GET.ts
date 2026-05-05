import z from "zod";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { redis } from "~/redis";
import { HttpServer } from "~/server/http/HttpServer";
import { resolvePlayer } from "~/server/http/resolver/player";

HttpServer.GET("/api/stasis/:botId/load", async function(req, res) {

	// Make sure we have a host set before accepting load requests
	if (!MinecraftClient.host) return res.status(503).json({
		success: false,
		error: "Server host is not defined."
	});

	// Resolve the player from the request, returning early if there's an error response
	const player = await resolvePlayer(req);
	if (player instanceof Response) return res.send(player);

	// Validate that the botId in the URL matches our bot's UUID
	const { data: destinationUuid, success } = z.uuid().safeParse(req.params.botId);
	if (!success) return res.status(400).json({
		success: false,
		error: "Invalid bot ID format."
	});

	// Request correct peer to load the player
	await redis.emit(`stasisproxy:cluster:${ MinecraftClient.host }`, {
		type: "request-load",
		destinationUuid,
		playerUuid: player.id
	});

	res.status(200).json({ success: true, data: player });

});
