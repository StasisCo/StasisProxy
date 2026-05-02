import armorManager from "mineflayer-armor-manager";
import { Module } from "../Module";
import { MinecraftClient } from "../MinecraftClient";

export default class AutoArmor extends Module {

	constructor() {
		super("AutoArmor");
	}

	public override onReady() {
		MinecraftClient.bot.loadPlugin(armorManager);
		MinecraftClient.bot.on("spawn", MinecraftClient.bot.armorManager.equipAll);
		if (MinecraftClient.bot.entity) MinecraftClient.bot.armorManager.equipAll();
	}

}
