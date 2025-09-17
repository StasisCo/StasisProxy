import type { Player } from "mineflayer";
import { Bot } from "../class/Bot";

export const aliases = [ "say" ];

export const admin = true;

/**
 * Make the bot say something in chat
 */
export default async function(_player: Player, args: string[]) {
	Bot.instance.chat(args.join(" "));
}