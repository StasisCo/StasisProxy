import { zMojangAccessToken } from "~/schema/mojang/zMojangAccessToken";
import { HttpServer } from "~/server/http/HttpServer";

HttpServer.GET("/api/stasis/:botId/load", async function(req, res) {

	// Authenticate with Mojang and get the users profile
	const accessToken = req.headers.authorization?.replace(/^Bearer\s+/, "").trim();
	const { data, success } = await zMojangAccessToken.safeParseAsync(accessToken);

	res.status(200).json({ success, data });

});
