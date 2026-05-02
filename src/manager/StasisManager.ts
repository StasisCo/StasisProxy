import { Embed } from "@vermaysha/discord-webhook";
import chalk from "chalk";
import { type Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type z from "zod";
import { Goal } from "~/class/Goal";
import { Logger } from "~/class/Logger";
import { Pearl } from "~/class/Pearl";
import { Stasis } from "~/class/Stasis";
import { StasisColumn } from "~/class/StasisColumn";
import { DiscordClient } from "~/client/discord/DiscordClient";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { STASIS_USER_MAX } from "~/config";
import { prisma } from "~/prisma";
import { redis } from "~/redis";
import type { zStasisStatus } from "~/schema/zStasisStatus";

export class StasisManager {
	
	public static readonly expectedInteractions = new Map<Stasis, number>();

	public static readonly logger = new Logger(chalk.hex("#00c5b5")("STASIS"));

	public static readonly pearls = new Map<number, Pearl>();

	constructor(private readonly bot: Bot) {
		if (this.bot.game) this.attach();
		else this.bot.once("login", this.attach);
	}
	
	/**
	 * Attach event listeners for tracking pearls and their velocities, as well as handling pearl destruction
	*/
	private readonly attach = () => {
		
		// Unclaim any stasis previously owned by this bot on the same server (in case of unclean shutdown)
		MinecraftClient.queue.once("leave-queue", async() => {
			const { count } = await prisma.stasis.updateMany({ where: { botId: MinecraftClient.bot.player.uuid, server: MinecraftClient.host }, data: { botId: null }});
			if (count > 0) StasisManager.logger.log(`Disconnected ${ chalk.yellow(count) } managed stasis on ${ chalk.cyan.underline(MinecraftClient.host) }`);
		});
		
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
			
			if (Pearl.isSuspended(packet.entityId)) return;
			if (pearl.suspended) {
				Pearl.markSuspended(packet.entityId);
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
				Pearl.clearSuspended(entityId);
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
				StasisManager.logger.warn(`Existing pearl ${ chalk.yellow(pearl.entity.id) } has no identifiable owner and will be ignored`);
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
		const owner = Object.values(MinecraftClient.bot.players).find(player => player.uuid === pearl.ownerId);

		// Ensure the pearl has an ownerId before proceeding
		if (!pearl.ownerId || !owner) {
			StasisManager.logger.warn(`Pearl ${ chalk.yellow(pearl.entity.id) } was thrown but has no identifiable owner and will be ignored`);
			return;
		}

		StasisManager.logger.log(`Player ${ chalk.cyan(owner.uuid) } threw pearl ${ chalk.yellow(pearl.entity.id) }`);

		const onDestroyed = () => StasisManager.logger.log(`Pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(owner.uuid) } broke`);
		pearl.once("destroyed", onDestroyed);

		// Wait for the pearl to enter stasis
		pearl.once("suspended", async() => {

			// If the pearl gets destroyed after stasis
			pearl.off("destroyed", onDestroyed);

			// Get the bounding box of the pearl in stasis, which we will use to find the corresponding stasis chamber
			const column = StasisColumn.get(pearl.entity.position as Vec3);
			if (!column) {
				StasisManager.logger.warn(`Failed to find a stasis chamber for pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(owner.uuid) }`);
				return;
			}

			// If we have an existing pearl that belongs to a different or unknown owner, we have a conflict and need to ignore this stasis chamber since we cant be sure which pearl is ours
			if (column.pearls.some(p => p.ownerId !== pearl.ownerId || !p.ownerId)) {
				MinecraftClient.chat.whisper(owner, "This stasis already belongs to someone else, your pearl will be ignored.");
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
				MinecraftClient.chat.whisper(owner, `You already have ${ all.length - 1 } / ${ STASIS_USER_MAX } pearls, ${ excess.length } will be removed.`);
				StasisManager.logger.warn(`Player ${ chalk.cyan(owner.uuid) } has too many stasis chambers (${ chalk.yellow(all.length) } / ${ chalk.yellow(STASIS_USER_MAX) }), removing ${ chalk.yellow(excess.length) } excess`);

				for (const extra of excess) await StasisManager.enqueue(extra.ownerId);
				return;
			}

			await DiscordClient.webhook(new Embed()
				.setTitle(`${ owner.username } Set Stasis`)
				.setColor(0x00c3b3)
				.setThumbnail({ url: `https://mc-heads.net/head/${ owner.uuid.replace(/-/g, "") }` })
				.addField({ name: "UUID", value: `${ owner.uuid }` })
				.addField({ name: "Dimension", value: `${ MinecraftClient.bot.game.dimension }`, inline: true })
				.addField({ name: "XYZ", value: `||\`${ stasis.block.position.floored().x }\` \`${ stasis.block.position.floored().y }\` \`${ stasis.block.position.floored().z }\`||`, inline: true })
				.addField({ name: "Pearls", value: `${ all.length } / ${ STASIS_USER_MAX }` }));

			MinecraftClient.chat.whisper(owner, `Pearl registered! You have ${ all.length } / ${ STASIS_USER_MAX } pearls.`);
			StasisManager.logger.log(`Saved stasis chamber ${ chalk.yellow(stasis.id) } for player ${ chalk.cyan(owner.uuid) }`);

		});

	}

	/**
	 * Enqueue a stasis to be activated.
	 * @param ownerId The UUID of the player who owns the stasis to be activated
	 * @param statusKey An optional Redis channel to publish status updates to (queued, arrived, succeeded, failed)
	 * @returns The number of remaining stasis chambers for the player after this one is activated, or -1 if no stasis was found
	 */
	public static async enqueue(ownerId: string, statusKey?: string, timeoutDuration = 1000 * 75) {
		StasisManager.logger.log(`Queuing stasis for player ${ chalk.cyan(ownerId) }...`);

		/** Status updater helper */
		const sendStatus = async(status: z.infer<typeof zStasisStatus>) => statusKey ? await redis.publish(statusKey, status) : undefined;

		// Get the nearest stasis chamber for this player
		const all = await Stasis.fetch(ownerId)
			.then(all => all.sort((a, b) => MinecraftClient.bot.entity.position.distanceTo(a.block.position) - MinecraftClient.bot.entity.position.distanceTo(b.block.position)));
		const [ stasis ] = all;

		if (!stasis) {
			StasisManager.logger.warn(`No stasis chambers found for player ${ chalk.cyan(ownerId) }`);
			return -1;
		};

		StasisManager.logger.log(`Found ${ chalk.yellow(all.length) } stasis for player ${ chalk.cyan(ownerId) }`, chalk.dim(`closest=${ MinecraftClient.bot.entity.position.distanceTo(stasis.block.position).toFixed(1) }m`));

		// Create a goal
		const goal = new Goal(stasis.block.position).setRange(5.0);
		goal.once("arrived", async() => {
			
			// Check the player is online
			const owner = Object.values(MinecraftClient.bot.players).find(p => p.uuid === ownerId);
			if (!owner) {
				
				// Send arrived statuss
				await sendStatus("arrived");
				StasisManager.logger.log(`Waiting for ${ chalk.cyan(ownerId) } to join...`);
	
				// Wait for the owner to appear in an add_player player_info packet
				const joined = await new Promise<boolean>(resolve => {

					const timeout = setTimeout(() => {
						MinecraftClient.bot._client.removeListener("packet", onPacket);
						StasisManager.logger.warn(`Timed out waiting for ${ chalk.cyan(ownerId) } to join`);
						resolve(false);
					}, timeoutDuration);
	
					// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol packet
					const onPacket = (data: any, meta: { name: string }) => {
						if (meta.name !== "player_info") return;
	
						// Newer (1.19.3+): action is a bitmask object; Legacy: action is a string
						const isAddPlayer = typeof data.action === "string"
							? data.action === "add_player"
							: data.action?.add_player === true;
						if (!isAddPlayer) return;
	
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw protocol entry
						if (!data.data?.some((entry: any) => entry.uuid === ownerId)) return;
	
						MinecraftClient.bot._client.removeListener("packet", onPacket);
						clearTimeout(timeout);
						resolve(true);

					};

					MinecraftClient.bot._client.on("packet", onPacket);
					
				});
				
				if (!joined) return sendStatus("timed-out");
				StasisManager.logger.log(`${ chalk.cyan(ownerId) } joined, activating stasis...`);

			}
			
			// Activate the stasis
			if (await stasis.activate()) {
				await stasis.remove();
				await sendStatus("succeeded");
			} else {
				await sendStatus("failed");
			}

		});

		// Now safe to push and await — the listener is already attached.
		MinecraftClient.pathfinding.pushGoal(goal);
		await sendStatus("queued");

		return all.length - 1;

	}

}