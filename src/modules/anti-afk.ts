import { type Bot } from "mineflayer";

/**
 * Punch air randomly every 30 seconds to avoid being kicked for being AFK.
 * @param bot The bot instance
 */
export default (bot: Bot) => setInterval(() => {
	
	if (!bot || !bot.entity) return;

	// Look around
	const yaw = Math.random() * Math.PI * 2;
	const pitch = (Math.random() - 0.5) * Math.PI;
	bot.look(yaw, pitch, true);

	// Swing arm
	bot.swingArm("right");

}, 30000);
