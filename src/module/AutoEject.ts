import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

// All 17 shulker box variants
const ITEM_BLACKLIST = new Set([
	"shulker_box",
	"white_shulker_box",
	"orange_shulker_box",
	"magenta_shulker_box",
	"light_blue_shulker_box",
	"yellow_shulker_box",
	"lime_shulker_box",
	"pink_shulker_box",
	"gray_shulker_box",
	"light_gray_shulker_box",
	"cyan_shulker_box",
	"purple_shulker_box",
	"blue_shulker_box",
	"brown_shulker_box",
	"green_shulker_box",
	"red_shulker_box",
	"black_shulker_box"
]);

export default class AutoEject extends Module {

	private ejecting = false;

	constructor() {
		super("AutoEject");
	}

	public override onTick() {
		if (Client.proxy.connected) return;
		if (this.ejecting) return;

		const item = Client.bot.inventory.slots.find(
			(s): s is NonNullable<typeof s> => s !== null && s !== undefined && ITEM_BLACKLIST.has(s.name)
		);
		if (!item) return;

		this.ejecting = true;
		Client.bot.tossStack(item)
			.catch(() => { /* item may have already been moved */ })
			.finally(() => {
				this.ejecting = false;
			});
	}

}
