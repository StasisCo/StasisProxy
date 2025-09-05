import chalk from "chalk";
import { type Bot as Mineflayer } from "mineflayer";
import { Client } from "~/app/Client";
import { Pearl, type OwnedPearl } from "~/class/Pearl";
import { Stasis } from "~/class/Stasis";
import { STASIS_USER_MAX } from "~/config";
import { Logger } from "~/util/Logger";

export class StasisManager {

	private static logger = new Logger(chalk.hex("#00c5b5")("STASIS"));

	constructor(private readonly bot: Mineflayer) {
		if (this.bot.game) this.onReady();
		else this.bot.once("login", this.onReady);
	}

	private readonly onReady = () => {

		this.bot._client.on("spawn_entity", async(packet: Packets.Schema["spawn_entity"]) => {
			
			// Get the entity
			const entity = this.bot.entities[packet.entityId];
			if (!entity || entity.name !== "ender_pearl" || entity.type !== "projectile") return;

			// Create a pearl instance to track
			const pearl = new Pearl(packet);

			// If the pearl is not in a stasis state, track it as a normal thrown pearl
			if (!pearl.suspended) return await StasisManager.onPearlThrown(pearl);
			return await pearl.resolve().then(StasisManager.onPearlEnterVisualRange);
	
		});

		this.bot.on("entityGone", async entity => {

			// Make sure we have a host
			if (!Client.host) throw new Error("No host found for entityGone event");

			// Make sure its an ender pearl
			if (entity.type !== "projectile" || entity.name !== "ender_pearl") return;

			// Get stasis from pearl
			const pearl = Pearl.from(entity);
			if (!pearl) return;

			// Search for a stasis
			const stasis = Stasis.from(pearl);
			if (!stasis) return;

			// If we have a stasis, remove it since the pearl is gone
			await stasis.remove();

		});

	};

	/**
	 * Handle an existing pearl entering visual range (e.g. on login or when coming out of a queue), 
	 * attempting to locate a stasis chamber for it if its already in stasis.
	 * @param pearl 
	 */
	private static async onPearlEnterVisualRange(pearl: Pearl) {

		// If there is no identifiable owner, ignore
		if (!pearl.isOwned()) {

			const stasis = Stasis.from(pearl);
			if (!stasis) return;
			
			const resolved = await stasis.resolve();
			if (!resolved) return;
			console.log({ resolved: resolved.id });
			
			const owner = Client.bot.players[resolved.ownerId];
			if (!owner) return;
			console.log({ owner: owner.username });

			await pearl.associate(owner);
			StasisManager.logger.log(`Existing pearl ${ chalk.yellow(`${ pearl.entity.id }`) } belonging to ${ chalk.cyan(owner.username) } entered visual range`);
			return;

		}

		// If the pearl is not suspended, treat it as a normal thrown pearl
		if (!pearl.suspended) return await StasisManager.onPearlThrown(pearl);
	
		// Locate a stasis chamber for this pearl
		const stasis = Stasis.from(pearl);
		if (!stasis) {
			StasisManager.logger.warn(`Failed to find a stasis chamber for existing pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(pearl.owner.username) }`);
			return;
		}

		StasisManager.logger.log(`Existing pearl ${ chalk.yellow(`${ pearl.entity.id }`) } belonging to ${ chalk.cyan(pearl.owner.username) } entered visual range`);
		await stasis.save(pearl.owner);

	}

	/**
	 * Handle a newly thrown pearl, waiting for it to enter stasis if necessary before attempting 
	 * to locate a stasis chamber
	 * @param pearl 
	 */
	private static async onPearlThrown(pearl: Pearl) {

		// Make sure we have an owned pearl
		if (!pearl.isOwned()) return StasisManager.logger.warn(`Pearl ${ chalk.yellow(pearl.entity.id) } has no identifiable owner, skipping tracking...`);
		StasisManager.logger.log(`Player ${ chalk.cyan(pearl.owner.username) } threw pearl ${ chalk.yellow(pearl.entity.id) }`);

		const onDestroyed = () => StasisManager.logger.log(`Pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(pearl.owner.username) } broke`);
		pearl.once("destroyed", onDestroyed);

		// Wait for the pearl to enter stasis
		pearl.once("suspended", async() => {

			// If the pearl gets destroyed after stasis
			if (pearl.destroyed) return;
			pearl.off("destroyed", onDestroyed);

			// At this point, we have a pearl that is stasised, but we need to actually identify the chamber
			const stasis = Stasis.from(pearl);
			if (!stasis) {
				StasisManager.logger.warn(`Failed to find a stasis chamber for pearl ${ chalk.yellow(pearl.entity.id) } belonging to player ${ chalk.cyan(pearl.owner.username) }`);
				return;
			}

			// Get any existing pearl entities in the stasis
			const existing = stasis.entities
				.filter(e => e.name === "ender_pearl" && e.type === "projectile" && e.id !== pearl.entity.id)
				.map(Pearl.from)
				.filter((p): p is Pearl => p !== null);

			// Resolve all owners of existing pearls
			const pearls = await Promise.allSettled(existing.map(pearl => pearl.resolve()))
				.then(results => results.filter(result => result.status === "fulfilled"))
				.then(results => results.map(result => result.value) as Array<Pearl | OwnedPearl>);

			// If we have an existing pearl that belongs to a different or unknown owner, we have a conflict and need to ignore this stasis chamber since we cant be sure which pearl is ours
			if (pearls.some(p => p.isOwned() && p.owner.uuid !== pearl.owner.uuid)) {
				const owner = await stasis.resolve()
					.then(stasis => stasis?.ownerId)
					.then(owner => owner ? Client.bot.players[owner] : null);
				if (owner) return StasisManager.logger.warn(`Stasis chamber at ${ chalk.yellow(stasis.block.position.toString()) } already belongs to ${ chalk.cyan(owner.username) }, ignoring pearl ${ chalk.yellow(pearl.entity.id) } from ${ chalk.cyan(pearl.owner.username) }`);
				StasisManager.logger.warn(`Stasis chamber at ${ chalk.yellow(stasis.block.position.toString()) } already contains a pearl belonging to an unknown owner, ignoring pearl ${ chalk.yellow(pearl.entity.id) } from ${ chalk.cyan(pearl.owner.username) }`);
				return;
			}

			// Save our stasis
			await stasis.save(pearl.owner);

			// Get all stasis chambers for this player
			const all = await Stasis.fetch(pearl.owner);

			// If they have too many, break and remove excess pearls until at the limit
			if (all.length > STASIS_USER_MAX && STASIS_USER_MAX >= 0) {
				const excess = all.slice(STASIS_USER_MAX);
				Client.chat.message(pearl.owner, `You already have ${ all.length - 1 } / ${ STASIS_USER_MAX } pearls, ${ excess.length } will be removed.`);
				StasisManager.logger.warn(`Player ${ chalk.cyan(pearl.owner.username) } has too many stasis chambers (${ chalk.yellow(all.length) } / ${ chalk.yellow(STASIS_USER_MAX) }), removing ${ chalk.yellow(excess.length) } excess`);

				for (const extra of excess) extra.enqueue();
				return;
			}

			Client.chat.message(pearl.owner, `Pearl registered! You have ${ all.length } / ${ STASIS_USER_MAX } pearls.`);
			StasisManager.logger.log(`Saved stasis chamber ${ chalk.yellow(stasis.id) } for player ${ chalk.cyan(pearl.owner.username) }`);

		});

	}

}