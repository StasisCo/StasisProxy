import type { Player } from "mineflayer";
import { prisma } from "..";
import { Bot } from "../class/Bot";
import { Logger } from "../class/Logger";
import { printObject } from "../utils/format";

export const aliases = [ "deop" ];

export const admin = true;

/**
 * Revokes operator status to a player
 */
export default async function(player: Player, [ target ]: string[]) {

	// Get the target player
	const onlineTarget = Object.values(Bot.instance.players)
		.find(e => target && e.username.toLowerCase() === target?.toLowerCase() || e.uuid === target?.toLowerCase());

	const offlineTarget = await prisma.players.findUnique({
		where: {
			observer_server_uuid_unique: {
				observer: Bot.instance.player.uuid,
				server: Bot.server,
				uuid: onlineTarget?.uuid || target?.toLowerCase() || ""
			}
		}
	});
	
	const pl = onlineTarget ? onlineTarget : offlineTarget;
	if (!pl) return `Player not found: '${ target }'`;

	if (!offlineTarget?.admin) return `Player '${ pl.username }' is not an operator`;

	// Set operator status in the database
	await prisma.players.update({
		where: {
			observer_server_uuid_unique: {
				observer: Bot.instance.player.uuid,
				server: Bot.server,
				uuid: pl.uuid
			}
		},
		data: {
			admin: false
		}
	});

	Logger.log("Revoked operator status:");
	printObject({
		by: player.username,
		to: pl.username
	});

	return `Player '${ pl.username }' is no longer an operator`;

}