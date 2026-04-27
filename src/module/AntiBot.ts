import { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { Goal } from "~/class/Goal";
import { Module } from "~/class/Module";

export default class AntiBot extends Module {

	private static readonly DIRECTIONS = [
		new Vec3(0, 0, 2),
		new Vec3(2, 0, 2),
		new Vec3(0, 0, -2),
		new Vec3(2, 0, -2),
		new Vec3(2, 0, 0),
		new Vec3(-2, 0, 2),
		new Vec3(-2, 0, 0),
		new Vec3(-2, 0, -2)
	];

	constructor() {
		super("AntiBot");
	}

	public override onReady() {
		
		if (Client.proxy.connected) return;

		const entity = Client.bot.entity;
		if (!entity) return;

		// Chunks aren't loaded yet at spawn — wait for them
		Client.bot.waitForChunksToLoad().then(() => {
			if (!Client.bot.entity) return;

			const home = Client.pathfinding.getHome();
			if (!home) return;

			const origin = home.floored() as Vec3;
			for (const dir of AntiBot.DIRECTIONS) {

				const feet = origin.plus(dir);
				const head = feet.offset(0, 1, 0);

				const feetBlock = Client.bot.blockAt(feet);
				const headBlock = Client.bot.blockAt(head);

				if (!feetBlock || !headBlock) continue;
				if (feetBlock.boundingBox === "empty" && headBlock.boundingBox === "empty") {

					const target = origin.plus(dir).offset(0.5, 0, 0.5) as Vec3;
					Client.pathfinding.pushGoal(new Goal(target).setRange(0.3).setTimeout(5000));

					break;

				}
				
			}

		});

	}

}
