import chalk from "chalk";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";
import { ModuleManager } from "~/manager/ModuleManager";
import AutoTotem from "./AutoTotem";

export default class AutoDisconnect extends Module {

	private static readonly options = {
		minHealth: 8,
		minTotems: 2,
		yLevel: {
			the_end: 0
		}
	};

	constructor() {
		super("AutoDisconnect");
	}

	public disconnect(reason?: string) {
		Client.exitCode = 0;
		if (reason) Client.logger.warn("Disconnecting:", chalk.yellow(reason));
		else Client.logger.warn("Disconnecting");
		Client.bot.quit(reason);
	}

	public override onPacket({ data, name }: Packets.PacketEvent) {

		// Exclude non us packets
		if (Client.bot.entity && typeof data === "object" && "entityId" in data && data.entityId !== Client.bot.entity.id) return;

		switch (name) {

			case "position":
				const cur = Client.bot.entity.position.clone();
				const { y, flags } = data;
				const ny = flags & 0x02 ? cur?.y ?? 0 + y : y;
				if (Client.bot.game.gameMode !== "survival") return;
				if (Client.bot.game.dimension in AutoDisconnect.options.yLevel) {
					const yLevel = AutoDisconnect.options.yLevel[Client.bot.game.dimension as keyof typeof AutoDisconnect.options.yLevel];
					if (typeof yLevel === "number" && ny < yLevel) {
						this.disconnect(`Y level was ${ ny } in ${ Client.bot.game.dimension }`);
					}
				}
				break;

			case "update_health":

				// Make sure were in survival
				if (Client.bot.game.gameMode !== "survival") return;

				// Check if health is below threshold
				const health = data.health;
				if (health <= AutoDisconnect.options.minHealth) {

					// Get the totems from autototem
					const autototem = ModuleManager.get<AutoTotem>("AutoTotem");
					const totems = autototem.totems.length;
					const holdingTotem = autototem.hasMainHand || autototem.hasOffHand;

					// If we have more totems than the threshold, don't disconnect yet
					if (totems > AutoDisconnect.options.minTotems && holdingTotem) return;

					// Disconnect if totems are below threshold
					if (totems === 0) this.disconnect(`Health was ${ health }`);
					else this.disconnect(`Health was ${ health } with only ${ totems } totems.`);

				}

				break;

			case "entity_status":
				if (data.entityId !== Client.bot.entity.id) return;
				if (data.entityStatus !== 35) return;

				// Get the totems from autototem
				const autototem = ModuleManager.get<AutoTotem>("AutoTotem");
				const totems = autototem.totems.length;

				// If we have more totems than the threshold, don't disconnect yet
				if (totems > AutoDisconnect.options.minTotems) return;
				this.disconnect(`Popped a totem with only ${ totems } left.`);
				break;

		}
	}

}
