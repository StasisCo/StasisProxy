import { Embed } from "@vermaysha/discord-webhook";
import type { Item } from "prismarine-item";
import AutoEat from "./AutoEat";
import type AutoXP from "./AutoXP";
import { Module } from "../Module";
import { MinecraftClient } from "../MinecraftClient";
import { DiscordClient } from "~/client/discord/DiscordClient";

export default class AutoTotem extends Module {

	constructor() {
		super("AutoTotem");
	}

	public override async onPacketReceive({ name, data }: Packets.PacketEvent) {
		switch (name) {

			// Totem pop event
			case "entity_status":
				if (data.entityId !== MinecraftClient.bot.entity.id) return;
				if (data.entityStatus !== 35) return;

				// Apply totem to off-hand
				this.applyHand("off-hand", true);

				// Send Discord notification
				await DiscordClient.webhook(new Embed()
					.setTitle("Popped Totem")
					.setColor(0xfacc15)
					.addField({ name: "Remaining Totems", value: `${ this.totems.map(_ => "<:totem_of_undying:1420233210347913357>").join("") } (${ this.totems.length })` }));
				break;

		}
	}

	public override onTickPre() {

		// Verify offhand and reequip if needed
		this.applyHand();

		// Don't mainhand if were eating
		if (Module.get<AutoEat>("AutoEat").isEating) return;
		
		// Don't mainhand if were mending
		if (Module.get<AutoXP>("AutoXP").isMending) return;
        
		// Apply mainhand
		this.applyHand("hand");

	}

	public get totems() {

		// search hotbar first for quicker access, then rest of inventory
		const hotbarTotems = MinecraftClient.bot.inventory.slots.slice(MinecraftClient.bot.inventory.hotbarStart, MinecraftClient.bot.inventory.hotbarStart + 9).filter(item => item && item.name === "totem_of_undying") as Item[];
		const inventoryTotems = MinecraftClient.bot.inventory.slots.slice(9).filter(item => item && item.name === "totem_of_undying") as Item[];

		return [ ...hotbarTotems, ...inventoryTotems ];
	}

	public get hasMainHand() {
		return MinecraftClient.bot.heldItem?.name === "totem_of_undying";
	}

	public get hasOffHand() {
		return MinecraftClient.bot.inventory.slots[45]?.name === "totem_of_undying";
	}

	private async applyHand(hand: "hand" | "off-hand" = "off-hand", force = false) {

		const slot = hand === "hand" ? MinecraftClient.bot.heldItem : MinecraftClient.bot.inventory.slots[45] || null;
		if (slot && slot.name === "totem_of_undying" && !force) return;

		// Don't try to equip a totem that's already in the other hand
		const [ totem ] = this.totems.filter(totem => {
			if (hand === "hand" && MinecraftClient.bot.inventory.slots[45]?.name === "totem_of_undying" && totem.slot === 45) return false;
			if (hand === "off-hand" && MinecraftClient.bot.heldItem?.name === "totem_of_undying" && totem.slot === MinecraftClient.bot.heldItem.slot) return false;
			return true;
		});

		// Equip the totem if we found one
		if (totem) await MinecraftClient.bot.equip(totem, hand);
        
	}

}
