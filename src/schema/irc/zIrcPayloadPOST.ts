import z from "zod";
import { zIrcEnvelope } from "./zIrcEnvelope";
import { zIrcPayload } from "./zIrcPayload";

/**
 * One item a POST /irc body may carry: either a bare payload (spoken as the
 * authenticated player) or a re-attribution {@link zIrcEnvelope} (spoken as the
 * `user` named inside it, honoured only for a key holding
 * {@link SCOPE.IRC_CONNECTION_UNAUTHENTICATED}).
 *
 * `zIrcPayload` is tried first, so anything with a known `type` discriminator is
 * a payload; the envelope has no `type` and matches only when the payload branch
 * has already been ruled out — the two shapes never collide.
 */
export const zIrcItem = z.union([
	zIrcPayload,
	zIrcEnvelope
]);

export type IrcItem = z.infer<typeof zIrcItem>;

/** A POST body: one item or a batch of them. */
export const zIrcPayloadPOST = z.union([
	zIrcItem,
	z.array(zIrcItem)
]);
