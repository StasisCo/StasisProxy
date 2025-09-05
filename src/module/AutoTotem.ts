import type { Item } from "prismarine-item";
import { Client } from "~/app/Client";
import { Module } from "~/class/Module";
import { ModuleManager } from "~/manager/ModuleManager";
import AutoEat from "./AutoEat";
import type AutoXP from "./AutoXP";

export default class AutoTotem extends Module {

	constructor() {
		super("AutoTotem");
	}

	private get totems() {
		return Client.bot.inventory.slots.filter(item => item && item.name === "totem_of_undying") as Item[];
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

	public override onPacket({ name, data }: Packets.PacketEvent) {
		switch (name) {

			// Totem pop event
			case "entity_status":
				if (data.entityId !== Client.bot.entity.id) return;
				if (data.entityStatus !== 35) return;

				// Apply totem to off-hand
				this.applyHand("off-hand", true);
                
				break;

		}
	}

	public override onTick() {

		// Verify offhand and reequip if needed
		this.applyHand();

		// Don't mainhand if were eating
		const autoeat = ModuleManager.get<AutoEat>("AutoEat");
		
		// Don't mainhand if were mending
		const autoxp = ModuleManager.get<AutoXP>("AutoXP");

		if (autoeat?.isEating) return;
		if (autoxp?.isMending) return;
        
		// Apply mainhand
		this.applyHand("hand");

	}

}
