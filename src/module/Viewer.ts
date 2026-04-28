import { mineflayer } from "prismarine-viewer";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";

export default class Viewer extends Module {
	constructor() {
		super("Viewer");
	}

	public override onReady(): void {
		Client.bot.once("spawn", () => mineflayer(Client.bot, { port: 3007 }));
	}

}