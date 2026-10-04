import chalk from "chalk";
import { randomBytes } from "crypto";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { Stasis } from "~/client/minecraft/Stasis";
import { STASIS_LOCATION_NAMES, STASIS_USER_MAX } from "~/config";
import { redis } from "~/redis";
import { normalizeUUID } from "~/utils";

type Query = Extract<Redis.ClusterMessage, { type: "stasis-query" }>;
type Reply = Extract<Redis.ClusterMessage, { type: "stasis-reply" }>;

/** The chambers one bot can see for a player, and how far it is from each one it could pull right now */
type View = NonNullable<Reply["stasis"]>;

interface PendingQuery {

	/** What each peer serving this location has answered so far, by bot UUID */
	views: Map<string, View>;

	/** How many peers have answered, whether or not they serve this location */
	answered: number;

	/** How many peers received the question */
	expected: number;

	/** Stop waiting and decide with the answers collected so far */
	finish: () => void;

}

interface Survey {

	/** How many pearls the player has across the pool. A chamber several bots can see counts once. */
	total: number;

	/** How many pearls the pool will hold for the player, or -1 if unlimited */
	limit: number;

	/** The bot that is closest to a pearl it could pull, or null if nobody can pull one */
	nearest: { botId: string, distance: number } | null;

}

/**
 * Bots on the same server that share a location name serve that location as one pool.
 *
 * A player's pearls are counted across the pool, against the sum of every member's own
 * STASIS_USER_MAX, and a load is carried out by whichever member is nearest to one of the
 * player's pearls. Names are aliases of one location, so sharing any one of them is enough.
 *
 * Nothing about the pool is configured: members find each other over the cluster channel each
 * time a question needs answering, and leave a record of their limit in Redis so the pool does
 * not shrink while one of them is restarting.
 */
export class ClusterManager {

	private static readonly logger = new Logger(chalk.hex("#00c5b5")("CLUSTER"));

	/** How long to wait for peers to say what they can see before deciding without them */
	private static readonly QUERY_TIMEOUT_MS = 1_500;

	/** How long a claim keeps the rest of the pool from handling the same event */
	private static readonly CLAIM_TTL_S = "5";

	/**
	 * How long a bot that has stopped checking in still counts towards the pool's pearl limit.
	 * Pearls over the limit get pulled, so a bot that is only restarting must not take its share
	 * of the limit away with it.
	 */
	private static readonly MEMBER_MEMORY_MS = 24 * 60 * 60 * 1_000;

	/** Questions this bot has asked the pool and is still collecting answers to, by query id */
	private static readonly queries = new Map<string, PendingQuery>();

	/** This bot's place on the cluster, or null while it is not connected to a server */
	private static get self() {
		const id = MinecraftClient.session?.selectedProfile.id;
		const host = MinecraftClient.host;
		if (!id || !host) return null;
		return {
			id: normalizeUUID(id),
			host,
			channel: `stasisproxy:cluster:${ host }`,
			pool: `stasisproxy:stasis:pool:${ host }`
		} as const;
	}

	/**
	 * Record this bot's location names and pearl limit for its peers. Runs on the presence
	 * heartbeat, including while queueing — a bot waiting to get back in is still part of its pool.
	 */
	public static async checkIn() {
		const self = this.self;
		if (!self) return;
		await redis.hset(self.pool, self.id, { locations: STASIS_LOCATION_NAMES, max: STASIS_USER_MAX, seen: Date.now() }).catch(() => undefined);
	}

	/**
	 * Take an event for this bot. Bots sharing a location hear the same chat and watch the same
	 * pearls, so each of them gets the event — the first to claim it handles it.
	 * @param event What identifies the event, the same on every bot that witnessed it
	 * @returns Whether this bot should handle the event
	 */
	public static async claim(...event: string[]) {
		const self = this.self;
		if (!self) return true;

		// Without Redis there is no pool to coordinate with, so act alone
		return await redis.set(`stasisproxy:stasis:claim:${ self.host }:${ event.join(":") }`, self.id, "EX", this.CLAIM_TTL_S, "NX")
			.then(result => result === "OK")
			.catch(() => true);
	}

	/**
	 * Count a player's pearls across the pool, and find the bot that could pull one soonest.
	 * @param playerUuid The UUID of the player who owns the pearls
	 */
	public static async survey(playerUuid: string): Promise<Survey> {
		const self = this.self;
		if (!self) return { total: 0, limit: STASIS_USER_MAX, nearest: null };

		const [ limit, mine, theirs ] = await Promise.all([ this.limit(self), this.view(playerUuid), this.ask(self, playerUuid) ]);

		const chambers = new Set<string>();
		let nearest: Survey["nearest"] = null;
		for (const [ botId, view ] of theirs.set(self.id, mine)) {
			for (const { id, distance } of view) {
				chambers.add(id);
				if (distance !== null && (!nearest || distance < nearest.distance)) nearest = { botId, distance };
			}
		}

		return { total: chambers.size, limit, nearest };
	}

	/**
	 * Load a player's pearl with whichever bot in the pool is nearest to one.
	 * @param playerUuid The UUID of the player who owns the pearl
	 * @param statusKey An optional Redis channel to publish status updates to
	 * @returns The player's remaining pearls and their limit, or null if there was no pearl to load
	 */
	public static async load(playerUuid: string, statusKey?: `stasisproxy:stasis:status:${ string }`) {
		const self = this.self;
		const { total, limit, nearest } = await this.survey(playerUuid);

		if (self && nearest && nearest.botId !== self.id) {
			this.logger.log(`Routing load for player ${ chalk.cyan(playerUuid) } to peer ${ chalk.cyan(nearest.botId) }`, chalk.dim(`closest=${ nearest.distance.toFixed(1) }m`));
			await redis.emit(self.channel, { type: "request-load", playerUuid, destinationUuid: nearest.botId, statusKey, direct: true });
			return { remaining: total - 1, limit };
		}

		if (nearest && await StasisManager.enqueue(playerUuid, statusKey) !== -1) return { remaining: total - 1, limit };

		// Nobody is travelling, so anything waiting on a status would otherwise wait forever
		if (statusKey) await redis.emit(statusKey, "failed");
		return null;
	}

	/**
	 * Answer a peer's question about a player's pearls. Every bot on the channel answers, even
	 * with nothing to say, so the peer knows when it has heard from everyone.
	 * @param query The question
	 * @param id This bot's UUID
	 * @param channel The cluster channel the question arrived on
	 */
	public static async answer(query: Query, id: string, channel: `stasisproxy:cluster:${ string }`) {
		if (query.from === id) return;
		const serves = query.locations.some(name => STASIS_LOCATION_NAMES.includes(name));
		await redis.emit(channel, { type: "stasis-reply", id: query.id, from: id, stasis: serves ? await this.view(query.playerUuid) : null });
	}

	/**
	 * Take in a peer's answer to a question this bot asked.
	 * @param reply The answer
	 */
	public static collect(reply: Reply) {
		const query = this.queries.get(reply.id);
		if (!query) return;
		if (reply.stasis) query.views.set(reply.from, reply.stasis);
		if (++query.answered >= query.expected) query.finish();
	}

	/** The chambers this bot can see for a player. Empty unless the bot is actually in the world. */
	private static async view(playerUuid: string): Promise<View> {
		if (!MinecraftClient.bot?.entity || MinecraftClient.queue?.isQueued !== false) return [];
		const { position } = MinecraftClient.bot.entity;

		return await Stasis.fetch(playerUuid)
			.then(all => all.map(stasis => {

				// The trigger block can be gone by the time we look — that chamber can't be pulled, but its pearl still counts
				let distance: number | null = null;
				try {
					if (stasis.isArmed()) distance = position.distanceTo(stasis.block.position);
				} catch {}

				return { id: stasis.id, distance };
			}))
			.catch(() => []);
	}

	/** Ask every other bot on the server what it can see for a player. Resolves once they have all answered. */
	private static ask(self: NonNullable<typeof ClusterManager.self>, playerUuid: string) {
		return new Promise<Map<string, View>>(resolve => {
			const id = randomBytes(8).toString("hex");
			const views = new Map<string, View>();

			const finish = () => {
				clearTimeout(timeout);
				this.queries.delete(id);
				resolve(views);
			};

			// A peer that is down or running an older version never answers
			const timeout = setTimeout(finish, this.QUERY_TIMEOUT_MS);

			const query: PendingQuery = { views, answered: 0, expected: Infinity, finish };
			this.queries.set(id, query);

			// Publishing reports how many bots received the question, this one included
			redis.emit(self.channel, { type: "stasis-query", id, from: self.id, playerUuid, locations: STASIS_LOCATION_NAMES })
				.then(receivers => {
					query.expected = receivers - 1;
					if (query.answered >= query.expected) finish();
				})
				.catch(finish);
		});
	}

	/** The pool's pearl limit: this bot's own, plus that of every peer that shares a location name with it. */
	private static async limit(self: NonNullable<typeof ClusterManager.self>) {
		const members: Record<string, Redis.FieldOf<typeof self.pool>> = await redis.hgetall(self.pool).catch(() => ({}));
		const limits = [ STASIS_USER_MAX ];

		for (const [ id, member ] of Object.entries(members)) {
			if (id === self.id) continue;

			if (Date.now() - member.seen > this.MEMBER_MEMORY_MS) {
				void redis.hdel(self.pool, id).catch(() => undefined);
				continue;
			}

			if (member.locations.some(name => STASIS_LOCATION_NAMES.includes(name))) limits.push(member.max);
		}

		// One unlimited member makes the whole pool unlimited
		if (limits.some(max => max < 0)) return -1;
		return limits.reduce((sum, max) => sum + max, 0);
	}

}
