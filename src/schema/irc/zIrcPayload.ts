import z from "zod";
import { zIrcChat } from "./payload/zIrcChat";
import { zIrcDeath } from "./payload/zIrcDeath";
import { zIrcEntityOwner } from "./payload/zIrcEntityOwner";
import { zIrcGame } from "./payload/zIrcGame";
import { zIrcKeepalive } from "./payload/zIrcKeepalive";
import { zIrcLogin } from "./payload/zIrcLogin";
import { zIrcLogout } from "./payload/zIrcLogout";
import { zIrcMessage } from "./payload/zIrcMessage";
import { zIrcPing } from "./payload/zIrcPing";
import { zIrcPresence } from "./payload/zIrcPresence";
import { zIrcResendRequest } from "./payload/zIrcResendRequest";

export const zIrcPayload = z.discriminatedUnion("type", [
	zIrcChat,
	zIrcDeath,
	zIrcEntityOwner,
	zIrcGame,
	zIrcKeepalive,
	zIrcLogin,
	zIrcLogout,
	zIrcMessage,
	zIrcPing,
	zIrcPresence,
	zIrcResendRequest
]);

export const zIrcPayloadPOST = z.union([
	zIrcPayload,
	z.array(zIrcPayload)
]);
