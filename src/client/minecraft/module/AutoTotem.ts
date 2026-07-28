import { Embed } from "@vermaysha/discord-webhook";
import type { Item } from "prismarine-item";
import z from "zod";
import { DiscordClient } from "~/client/discord/DiscordClient";
import { MinecraftClient } from "../MinecraftClient";
import { Module } from "../Module";
import AutoEat from "./AutoEat";
import type AutoXP from "./AutoXP";

const zConfigSchema = z.object({
	mainhand: z.boolean().default(true).describe("Whether to equip totems in the main hand")
});

/** Offhand inventory slot index. */
const OFFHAND_SLOT = 45;

/** Ticks to wait after issuing a swap before issuing another, so the server can catch up. */
const SWAP_COOLDOWN_TICKS = 4;

export default class AutoTotem extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	constructor() {
		super("AutoTotem");
	}

	private cooldown = 0;

	public override async onPacketReceive({ name, data }: Packets.PacketEvent) {
		switch (name) {

			// Totem pop event
			case "entity_status":
				if (data.entityId !== MinecraftClient.bot.entity.id) return;
				if (data.entityStatus !== 35) return;

				// Re-arm immediately — a pop means the offhand slot is now empty.
				this.cooldown = 0;
				this.applyOffhand();

				// Send Discord notification
				await DiscordClient.webhook(new Embed()
					.setTitle("Popped Totem")
					.setColor(0xfacc15)
					.addField({ name: "Remaining Totems", value: `${ this.totems.map(_ => "<:totem_of_undying:1420233210347913357>").join("") } (${ this.totems.length })` }));
				break;

		}
	}

	public override onTickPre() {

		if (this.cooldown > 0) {
			this.cooldown--;
			return;
		}

		// Keep the offhand stocked first — it is what actually saves us.
		if (!this.hasOffHand) {

			// Getting a totem into the offhand means swapping it out of the main hand, which
			// would destroy an in-progress eat. Totem beats food: end the eat and take the totem
			// on the next tick.
			const autoEat = Module.get<AutoEat>("AutoEat");
			if (autoEat.isEating) {
				autoEat.stopEating();
				return;
			}

			this.applyOffhand();
			return;
		}

		// Don't fight AutoEat or AutoXP over the main hand.
		if (Module.get<AutoEat>("AutoEat").isEating) return;
		if (Module.get<AutoXP>("AutoXP").isMending) return;

		if (this.config.mainhand) this.applyMainhand();

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
		return MinecraftClient.bot.inventory.slots[OFFHAND_SLOT]?.name === "totem_of_undying";
	}

	/** The hotbar index of a totem, or -1 if none is in the hotbar. */
	private totemHotbarIndex(): number {
		const inventory = MinecraftClient.bot.inventory;
		for (let i = 0; i < 9; i++) {
			if (inventory.slots[inventory.hotbarStart + i]?.name === "totem_of_undying") return i;
		}
		return -1;
	}

	/**
	 * Put a totem in the off-hand.
	 *
	 * Selects the hotbar slot holding a totem and exchanges the hands. That is a twelve-byte
	 * player action with no container menu behind it — as opposed to `bot.equip(item, "off-hand")`,
	 * which performs two pickup clicks with a live cursor against a menu whose state the server
	 * independently tracks, and which is by far the most heavily validated way to move an item.
	 */
	private applyOffhand() {
		const hotbarIndex = this.totemHotbarIndex();

		if (hotbarIndex === -1) {
			this.stageTotemIntoHotbar();
			return;
		}

		if (MinecraftClient.bot.quickBarSlot !== hotbarIndex && !MinecraftClient.interaction.setHotbarSlot(hotbarIndex)) return;
		if (!MinecraftClient.interaction.swapOffhand()) return;

		this.cooldown = SWAP_COOLDOWN_TICKS;
	}

	/** Hold a totem in the main hand, if one is already in the hotbar. */
	private applyMainhand() {
		if (this.hasMainHand) return;

		const hotbarIndex = this.totemHotbarIndex();
		if (hotbarIndex === -1) {
			this.stageTotemIntoHotbar();
			return;
		}

		if (MinecraftClient.interaction.setHotbarSlot(hotbarIndex)) this.cooldown = SWAP_COOLDOWN_TICKS;
	}

	/** Move a totem from the main inventory into the hotbar with a single atomic swap click. */
	private stageTotemIntoHotbar() {
		const inventory = MinecraftClient.bot.inventory;
		const totem = this.totems.find(item => item.slot < inventory.hotbarStart || item.slot >= inventory.hotbarStart + 9);
		if (!totem) return;

		const click = MinecraftClient.interaction.stageIntoHotbar(totem);
		if (!click) return;

		void click.catch(() => { /* slot moved underneath us; retried next tick */ });
		this.cooldown = SWAP_COOLDOWN_TICKS;
	}

}
