import { readdir } from "fs/promises";
import type { Bot } from "mineflayer";
import { Client } from "~/app/Client";
import { Module } from "~/class/Module";

export class ModuleManager {

	public static readonly modules = new Map<string, Module>();

	public static get<T extends Module>(name: string): T | undefined {
		return this.modules.get(name) as T | undefined;
	}

	private static async init() {
		for (const file of await readdir("src/module", { withFileTypes: true, recursive: true })) {
			if (!file.isFile()) continue;
			if (!file.name.endsWith(".ts") && !file.name.endsWith(".js")) continue;
			await import(`../module/${ file.name }`).then(module => this.modules.set(module.default.name, new module.default())).catch(err => {
				console.error(`Failed to load module from file ${ file.name }:`, err);
			});
		}

		// Fire onReady for all modules that implement it
		ModuleManager.fireReady();
	}

	private static fireReady() {
		const ready = () => {
			for (const module of ModuleManager.modules.values()) {
				if (module.onReady) module.onReady();
			}

			// Hook module onTick into the physics pre-tick loop
			Client.physics.onPreTick.push(() => {
				for (const module of ModuleManager.modules.values()) {
					if (module.onTick) module.onTick();
				}
			});
		};

		if (Client.queue?.queued) {
			Client.queue.once("leave-queue", () => Client.bot.once("spawn", ready));
		} else if (Client.bot.entity) {
			ready();
		} else {
			Client.bot.once("spawn", ready);
		}
	}

	constructor(private readonly bot: Bot) {
		ModuleManager.init();
		bot._client.on("packet", (data, { name }) => {
			for (const module of ModuleManager.modules.values()) {
				if (module.onPacket) module.onPacket({ name: name as keyof Packets.Schema, data });
			}
		});
	}

}