import z from "zod";
import { zIrcPayload } from "./zIrcPayload";

/**
 * The re-attribution envelope: an ordinary IRC payload wrapped in an explicit
 * sender, so a privileged key can post it AS another player rather than as
 * itself.
 *
 * The other POST shape — a bare {@link zIrcPayload} — is spoken by the player
 * behind the key, and the mesh stamps the meta frame's `uuid` from the
 * authenticated account. This shape moves that decision into the body: `user`
 * and `userAgent` become the meta frame, and `message` is the payload delivered
 * under it, indistinguishable on the wire from one the named player sent
 * themselves.
 *
 * It carries no `type` of its own, which is exactly what tells it apart from a
 * payload at parse time — every payload has a `type` discriminator and this has
 * none. Accepting it is NOT the same as honouring it: only a key holding
 * {@link SCOPE.IRC_CONNECTION_UNAUTHENTICATED} may send one, and the POST route
 * silently drops it for anyone else (see routes/irc/POST.ts). Without that gate
 * this would be an identity-spoofing primitive for every key on the mesh.
 *
 * `channel` names the multiplayer server this one message is for. It moves the
 * routing off the `x-irc-multiplayer-server` header and INTO the message, which
 * is what lets a single POST fan out to several channels at once — each envelope
 * carries its own. Optional: omitted, the message falls back to the request
 * header's channel, so a bridge posting to one server need not repeat it.
 */
export const zIrcEnvelope = z.object({
	user: z.uuid(),
	userAgent: z.string(),
	channel: z.string().optional(),
	message: zIrcPayload
});

export type IrcEnvelope = z.infer<typeof zIrcEnvelope>;
