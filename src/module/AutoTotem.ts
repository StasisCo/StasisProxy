import { Embed } from "@vermaysha/discord-webhook";
import type { Item } from "prismarine-item";
import { Client } from "~/class/Client";
import { Module } from "~/class/Module";
import AutoEat from "./AutoEat";
import type AutoXP from "./AutoXP";

export default class AutoTotem extends Module {

	constructor() {
		super("AutoTotem");
	}

	public override async onPacketReceive({ name, data }: Packets.PacketEvent) {
		switch (name) {

			// Totem pop event
			case "entity_status":
				if (data.entityId !== Client.bot.entity.id) return;
				if (data.entityStatus !== 35) return;

				// Apply totem to off-hand
				this.applyHand("off-hand", true);

				// Send Discord notification
				await Client.discord.webhook(new Embed()
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
		const hotbarTotems = Client.bot.inventory.slots.slice(Client.bot.inventory.hotbarStart, Client.bot.inventory.hotbarStart + 9).filter(item => item && item.name === "totem_of_undying") as Item[];
		const inventoryTotems = Client.bot.inventory.slots.slice(9).filter(item => item && item.name === "totem_of_undying") as Item[];

		return [ ...hotbarTotems, ...inventoryTotems ];
	}

	public get hasMainHand() {
		return Client.bot.heldItem?.name === "totem_of_undying";
	}

	public get hasOffHand() {
		return Client.bot.inventory.slots[45]?.name === "totem_of_undying";
	}

	private async applyHand(hand: "hand" | "off-hand" = "off-hand", force = false) {

		const slot = hand === "hand" ? Client.bot.heldItem : Client.bot.inventory.slots[45] || null;
		if (slot && slot.name === "totem_of_undying" && !force) return;

		// Don't try to equip a totem that's already in the other hand
		const [ totem ] = this.totems.filter(totem => {
			if (hand === "hand" && Client.bot.inventory.slots[45]?.name === "totem_of_undying" && totem.slot === 45) return false;
			if (hand === "off-hand" && Client.bot.heldItem?.name === "totem_of_undying" && totem.slot === Client.bot.heldItem.slot) return false;
			return true;
		});

		// Equip the totem if we found one
		if (totem) await Client.bot.equip(totem, hand);
        
	}

}
