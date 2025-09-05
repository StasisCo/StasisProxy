import armorManager from "mineflayer-armor-manager";
import { Client } from "~/app/Client";
import { Module } from "~/class/Module";

export default class AutoArmor extends Module {

	constructor() {
		super("AutoArmor");
		Client.bot.loadPlugin(armorManager);
		Client.bot.on("spawn", Client.bot.armorManager.equipAll);
		if (Client.bot.entity) Client.bot.armorManager.equipAll();
	}

}
