import chalk from "chalk";
import { type Bot } from "mineflayer";
import { type Item } from "prismarine-item";
import { TOTEM_BUFFER } from "../../config";
import { Logger } from "../class/Logger";

export default function(bot: Bot) {

	const getTotems = () => bot.inventory.slots.filter(item => item && item.name === "totem_of_undying") as Item[];

	async function applyTotem() {

		// Make sure bot and inventory exist
		const offhand = bot.inventory.slots[45];

		// If already holding a totem, ignore
		if (offhand && offhand.name === "totem_of_undying") return;

		// Count the totems in the inventory
		const totems = getTotems();
		if (!totems[0]) return;

		await bot.equip(totems[0], "off-hand");
        
	}

	bot.on("physicsTick", () => applyTotem());

	// On pop
	bot._client.on("packet", (data, meta) => {
		const name = meta.name;
		if (name !== "entity_event" && name !== "entity_status") return;
		const code = data?.entityStatus ?? data?.status ?? data?.eventId;
		if (code !== 35) return;
		const eid = data?.entityId ?? data?.entity_id ?? data?.id;
		if (typeof eid !== "number") return;
		const entity = bot.entities[eid];
		if (!entity || entity.id !== bot.player.entity.id) return;

		// Count the totems in the inventory
		const totems = bot.inventory.slots.filter(item => item && item.name === "totem_of_undying");
		if (totems.length <= TOTEM_BUFFER) {
			Logger.error(`${ chalk.yellow(totems.length) } totems remaining, disconnecting...`);
			bot.quit();
			process.exit(0);
		}

		Logger.warn(`Popped a totem, ${ chalk.yellow(totems.length) } remaining`);

		applyTotem();

	});

};
    