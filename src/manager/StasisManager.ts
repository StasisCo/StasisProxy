import { Embed } from "@vermaysha/discord-webhook";
import chalk from "chalk";
import { type Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { Client } from "~/class/Client";
import { Goal } from "~/class/Goal";
import { Logger } from "~/class/Logger";
import { Pearl } from "~/class/Pearl";
import { Stasis } from "~/class/Stasis";
import { StasisColumn } from "~/class/StasisColumn";
import { STASIS_USER_MAX } from "~/config";

export class StasisManager {

	public static readonly logger = new Logger(chalk.hex("#00c5b5")("STASIS"));
	public static readonly pearls = new Map<number, Pearl>();
	public static readonly interactions = new Map<Stasis, number>();
	private static readonly suspended = new Set<number>();

	constructor(private readonly bot: Bot) {
		if (this.bot.game) this.attach();
		else this.bot.once("login", this.attach);
	}

	/**
	 * Attach event listeners for tracking pearls and their velocities, as well as handling pearl destruction
	 */
	private readonly attach = () => {

		// When an entity spawns
		this.bot._client.on("spawn_entity", (packet: Packets.Schema["spawn_entity"]) => {
			
			// Get the entity
			const entity = this.bot.entities[packet.entityId];
			if (!entity || entity.name !== "ender_pearl" || entity.type !== "projectile") return;

			// Create a pearl instance
			const pearl = new Pearl(packet);
			StasisManager.pearls.set(packet.entityId, pearl);
			StasisManager.onPearl(pearl);
	
		});

		// When a entity velocity updates
		this.bot._client.on("entity_velocity", (packet: Packets.Schema["entity_velocity"]) => {

			// Check if this is a pearl we are tracking
			const pearl = StasisManager.pearls.get(packet.entityId);
			if (!pearl) return;
		
			// Update the pearl's velocity based on the packet data
			const velocity = new Vec3(packet.velocity.x / 8000, packet.velocity.y / 8000, packet.velocity.z / 8000);
			pearl.entity.velocity = velocity;
			pearl.emit("velocity", velocity);
			
			if (StasisManager.suspended.has(packet.entityId)) return;
			if (pearl.suspended) {
				StasisManager.suspended.add(packet.entityId);
				pearl.emit("suspended");
			}
		
		});

		// When an entity is destroyed
		this.bot._client.on("entity_destroy", (packet: Packets.Schema["entity_destroy"]) => {
			for (const entityId of packet.entityIds) {

				// Check if this is a pearl we are tracking
				const pearl = StasisManager.pearls.get(entityId);
				if (!pearl) continue;
				void Stasis.from(pearl).then(stasis => {
					if (stasis) {
						void stasis.releaseManagement();
						Stasis.instances.delete(stasis.id);
					}
				});

				// If it is, emit a log and remove it from tracking
				StasisManager.logger.log(`Pearl ${ chalk.yellow(pearl.entity.id) } broke or despawned`);
				StasisManager.pearls.delete(entityId);
				StasisManager.suspended.delete(entityId);
				pearl.emit("destroyed", pearl.entity.id);
				pearl.removeAllListeners();

			}
		});

	};

	/**
	 * Handle a pearl entering visual range
	 * @param pearl 
	 */
	private static async onPearl(pearl: Pearl) {

		// If there is no identifiable owner, ignore
		if (!pearl.ownerId) {

			// Wait for up to 5 seconds for the pearl to emit an owner event
			const ownerIdentified = new Promise<string>(resolve => pearl.once("owner", resolve));
			const ownerFailed = new Promise<void>(resolve => pearl.once("owner-failed", resolve));
			
			// If an owner is identified within the timeout, associate the pearl with that owner, otherwise ignore the pearl
			const ownerId = await Promise.race([ ownerIdentified, ownerFailed ]) || null;
			if (!ownerId) {
				StasisManager.logger.warn(`Pearl ${ chalk.yellow(pearl.entity.id) } has no identifiable owner and will be ignored`);
				return;
			}

		}

		// .From a stasis
		await Stasis.from(pearl);

		// If the pearl is not suspended, treat it as a normal thrown pearl
		if (!pearl.suspended) return await StasisManager.onPearlThrown(pearl);
		StasisManager.logger.log(`Existing pearl ${ chalk.yellow(`${ pearl.entity.id }`) } belonging to ${ chalk.cyan(pearl.ownerId) } entered visual range`);

	}

	/**
	 * Handle a pearl being thrown by a player
	 * @param pearl 
	 */
	private static async onPearlThrown(pearl: Pearl) {

		// Locate an online owner
		const owner = Object.values(Client.bot.players).find(player => player.uuid === pearl.ownerId);

		// Ensure the pearl has an ownerId before proceeding
		if (!pearl.ownerId || !owner) {
			StasisManager.logger.warn(`Pearl ${ chalk.yellow(pearl.entity.id) } was thrown but has no identifiable owner and will be ignored`);
			return;
		}

		StasisManager.logger.log(`Player ${ chalk.cyan(owner.username) } threw pearl ${ chalk.yellow(pearl.entity.id) }`);

		const onDestroyed = () => StasisManager.logger.log(`Pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(owner.username) } broke`);
		pearl.once("destroyed", onDestroyed);

		// Wait for the pearl to enter stasis
		pearl.once("suspended", async() => {

			// If the pearl gets destroyed after stasis
			pearl.off("destroyed", onDestroyed);

			// Get the bounding box of the pearl in stasis, which we will use to find the corresponding stasis chamber
			const column = StasisColumn.get(pearl.entity.position as Vec3);
			if (!column) {
				StasisManager.logger.warn(`Failed to find a stasis chamber for pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(owner.username) }`);
				return;
			}

			// If we have an existing pearl that belongs to a different or unknown owner, we have a conflict and need to ignore this stasis chamber since we cant be sure which pearl is ours
			if (column.pearls.some(p => p.ownerId !== pearl.ownerId || !p.ownerId)) {
				Client.chat.whisper(owner, "This stasis already belongs to someone else, your pearl will be ignored.");
				return;
			}

			// Save the stasis to the database
			const stasis = await column.save(owner);
			if (!stasis) return;

			// Get all stasis chambers for this player
			const all = await Stasis.fetch(owner.uuid);

			// If they have too many, break and remove excess pearls until at the limit
			if (all.length > STASIS_USER_MAX && STASIS_USER_MAX >= 0) {
				const excess = all.slice(STASIS_USER_MAX);
				Client.chat.whisper(owner, `You already have ${ all.length - 1 } / ${ STASIS_USER_MAX } pearls, ${ excess.length } will be removed.`);
				StasisManager.logger.warn(`Player ${ chalk.cyan(owner.uuid) } has too many stasis chambers (${ chalk.yellow(all.length) } / ${ chalk.yellow(STASIS_USER_MAX) }), removing ${ chalk.yellow(excess.length) } excess`);

				for (const extra of excess) extra.enqueue();
				return;
			}

			await Client.discord.webhook(new Embed()
				.setTitle(`${ owner.username } Set Stasis`)
				.setColor(0x00c3b3)
				.setThumbnail({ url: `https://mc-heads.net/head/${ owner.uuid.replace(/-/g, "") }` })
				.addField({ name: "UUID", value: `${ owner.uuid }` })
				.addField({ name: "Dimension", value: `${ Client.bot.game.dimension }`, inline: true })
				.addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
				.addField({ name: "Pearls", value: `${ all.length } / ${ STASIS_USER_MAX }` }));

			Client.chat.whisper(owner, `Pearl registered! You have ${ all.length } / ${ STASIS_USER_MAX } pearls.`);
			StasisManager.logger.log(`Saved stasis chamber ${ chalk.yellow(stasis.id) } for player ${ chalk.cyan(owner.username) }`);

		});

	}

	/**
	 * Enqueue a stasis to be activated
	 */
	public static enqueue(stasis: Stasis, mode: "online" | "offline" = "online") {
	
		// Initialize the goal
		const goal = new Goal(stasis.block.position).setRange(5.0);
			
		switch (mode) {
				
			// Online mode
			case "online":
				goal.once("arrived", async() => {
						
					// Check the player is still online (players is keyed by username, owner is a UUID)
					const owner = Object.values(Client.bot.players).find(p => p.uuid === stasis.ownerId);
					if (!owner) return StasisManager.logger.warn(`Owner of stasis ${ chalk.yellow(stasis.id) } is offline, skipping activation`);

					// Get the pearls in the stasis before interacting
					const pearls = stasis.pearls;

					// Interact with the stasis and wait for confirmation
					for (let attempt = 1; attempt <= 3; attempt++) {
						const interacted = await stasis.interact();
						if (interacted) break;
						StasisManager.logger.warn(`Failed to interact with stasis ${ chalk.yellow(stasis.id) } belonging to player ${ chalk.cyan(owner.username) }, attempt ${ chalk.yellow(attempt) }`);
						if (attempt === 3) return;
						await new Promise(res => setTimeout(res, 1000));
					}
					
					// Wait for all pearls in the stasis to break, with a timeout in case something goes wrong
					const timeout = new Promise<void>(resolve => setTimeout(resolve, 1000));
					const pearlsDestroyed = Promise.all(pearls.map(pearl => new Promise(res => pearl.once("destroyed", res))));
					await Promise.race([ timeout, pearlsDestroyed ]);

					// Make sure all the pearls were destroyed
					if (pearls.map(p => p.entity.id).every(id => !StasisManager.pearls.has(id))) {
						await stasis.remove();
						return;
					}

					// Otherwise, queue another stasis for the user
					const next = await Stasis.fetch(stasis.ownerId).then(all => all.find(s => s.id !== stasis.id));
					if (!next) {
						Client.chat.whisper(owner, "The pearl in stasis did not break, and you have no others.");
						return;
					}
					
					Client.chat.whisper(owner, "The pearl in stasis did not break. Trying another...");
					next.enqueue();

				});
				break;
	
			// 	// Offline mode
			// case "offline":
			// 	goal.once("arrived", async() => {
	
			// 		// 			// LegacyStasis.logger.log("Waiting for owner to join...");
	
			// 		// 			// // Wait for the owner to appear in an add_player player_info packet
			// 		// 			// const joined = await new Promise<boolean>(resolve => {
			// 		// 			// 	const timeout = setTimeout(() => {
			// 		// 			// 		Client.bot._client.removeListener("packet", onPacket);
			// 		// 			// 		LegacyStasis.logger.warn("Timed out waiting for owner to join");
			// 		// 			// 		resolve(false);
			// 		// 			// 	}, 70000);
	
			// 		// 			// 	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol packet
			// 		// 			// 	const onPacket = (data: any, meta: { name: string }) => {
			// 		// 			// 		if (meta.name !== "player_info") return;
	
			// 		// 			// 		// Newer (1.19.3+): action is a bitmask object; Legacy: action is a string
			// 		// 			// 		const isAddPlayer = typeof data.action === "string"
			// 		// 			// 			? data.action === "add_player"
			// 		// 			// 			: data.action?.add_player === true;
			// 		// 			// 		if (!isAddPlayer) return;
	
			// 		// 			// 		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol entry
			// 		// 			// 		if (!data.data?.some((entry: any) => entry.uuid === this.ownerId)) return;
	
			// 		// 			// 		Client.bot._client.removeListener("packet", onPacket);
			// 		// 			// 		clearTimeout(timeout);
			// 		// 			// 		resolve(true);
			// 		// 			// 	};
	
			// 		// 			// 	Client.bot._client.on("packet", onPacket);
			// 		// 			// });
	
			// 		// 			// if (!joined) return;
			// 		// 			// const pearlIds = new Set(this.entities.map(entity => entity.id));
	
			// 		// 			// const interacted = await this.interact();
			// 		// 			// if (!interacted) return;
	
			// 		// 			// await this.waitForPearlBreak(pearlIds);
	
			// 	});
			// 	break;
	
		}
	
		Client.pathfinding.pushGoal(goal);
	
	}

}