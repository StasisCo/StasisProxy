import z from "zod";
import { zPlayer } from "../../zPlayer";

/**
 * The shape rule for player references: a payload about the SENDER carries the
 * bare uuid (ping) or nothing at all (chat, message, presence — the meta
 * frame's `uuid` identifies them), while a payload about a THIRD PARTY
 * carries the full {uuid, name} object, because the name is payload data with
 * no other way to travel. An entity's owner is a third party: a stasis proxy names the players
 * whose pearls it holds, none of them the account behind the key. So are
 * logout/death/login, which report on observed players.
 */
export const zIrcEntityOwner = z.object({
	type: z.literal("entity_owner"),
	owner: zPlayer,
	id: z.string()
});
