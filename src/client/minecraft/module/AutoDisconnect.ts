import chalk from "chalk";
import z from "zod";
import AutoTotem from "./AutoTotem";
import { Module } from "../Module";
import { MinecraftClient } from "../MinecraftClient";

const zConfigSchema = z.object({
	minHealth: z
		.number()
		.default(8)
		.describe("Disconnect when health drops to this value or below"),
	minTotems: z
		.number()
		.default(2)
		.describe("Stay connected as long as this many totems remain in the inventory"),
	yLevel: z
		.object({
			the_end: z.number().default(0).describe("Disconnect when Y is below this in the_end")
		})
		.default({ the_end: 0 })
		.describe("Per-dimension Y-level safety floors")
});

export default class AutoDisconnect extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	constructor() {
		super("AutoDisconnect");
	}

	public disconnect(reason?: string) {
		if (reason) MinecraftClient.logger.warn("Disconnecting:", chalk.yellow(reason));
		else MinecraftClient.logger.warn("Disconnecting");
		MinecraftClient.exit(0);
	}

	public override onPacketReceive({ data, name }: Packets.PacketEvent) {

		// Exclude non us packets
		if (MinecraftClient.bot.entity && typeof data === "object" && "entityId" in data && data.entityId !== MinecraftClient.bot.entity.id) return;

		switch (name) {

			case "position":
				const cur = MinecraftClient.bot.entity.position.clone();
				const { y, flags } = data;
				const ny = flags & 0x02 ? cur?.y ?? 0 + y : y;
				if (MinecraftClient.bot.game.gameMode !== "survival") return;
				if (MinecraftClient.bot.game.dimension in this.config.yLevel) {
					const yLevel = this.config.yLevel[MinecraftClient.bot.game.dimension as keyof typeof this.config.yLevel];
					if (typeof yLevel === "number" && ny < yLevel) {
						this.disconnect(`Y level was ${ ny } in ${ MinecraftClient.bot.game.dimension }`);
					}
				}
				break;

			case "update_health":

				// Make sure were in survival
				if (MinecraftClient.bot.game.gameMode !== "survival") return;

				// Check if health is below threshold
				const health = data.health;
				if (health <= this.config.minHealth) {

					// Get the totems from autototem
					const autototem = Module.get<AutoTotem>("AutoTotem");
					const totems = autototem.totems.length;
					const holdingTotem = autototem.hasMainHand || autototem.hasOffHand;

					// If we have more totems than the threshold, don't disconnect yet
					if (totems > this.config.minTotems && holdingTotem) return;

					// Disconnect if totems are below threshold
					if (totems === 0) this.disconnect(`Health was ${ health }`);
					else this.disconnect(`Health was ${ health } with only ${ totems } totems.`);

				}

				break;

			case "entity_status":
				if (data.entityId !== MinecraftClient.bot.entity.id) return;
				if (data.entityStatus !== 35) return;

				// Get the totems from autototem
				const autototem = Module.get<AutoTotem>("AutoTotem");
				const totems = autototem.totems.length;

				// If we have more totems than the threshold, don't disconnect yet
				if (totems > this.config.minTotems) return;
				this.disconnect(`Popped a totem with only ${ totems } left.`);
				break;

		}
	}

}
