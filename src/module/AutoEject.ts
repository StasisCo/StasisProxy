import z from "zod";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

const zConfigSchema = z.object({
	items: z
		.string()
		.array()
		.default([
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
		])
		.describe("Item names that should be tossed out of the inventory on sight")
});

export default class AutoEject extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	private ejecting = false;
	private blacklist = new Set<string>();

	constructor() {
		super("AutoEject");
	}

	public override onConfigReload() {
		this.blacklist = new Set(this.config.items);
	}

	public override onTickPre() {
		if (Client.proxy.connected) return;
		if (this.ejecting) return;

		if (this.blacklist.size === 0) this.blacklist = new Set(this.config.items);

		const item = Client.bot.inventory.slots.find(
			(s): s is NonNullable<typeof s> => s !== null && s !== undefined && this.blacklist.has(s.name)
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
