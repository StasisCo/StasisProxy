import chalk from "chalk";
import { randomBytes } from "crypto";
import { Logger } from "~/class/Logger";
import { MinecraftClient } from "~/client/minecraft/MinecraftClient";
import { StasisManager } from "~/client/minecraft/manager/StasisManager";
import { Stasis } from "~/client/minecraft/Stasis";
import { STASIS_LOCATION_NAMES, STASIS_SITE_MAX } from "~/config";
import { redis } from "~/redis";
import { normalizeUUID } from "~/utils";

type Query = Extract<Redis.ClusterMessage, { type: "stasis-query" }>;
type Reply = Extract<Redis.ClusterMessage, { type: "stasis-reply" }>;

/** The chambers one bot can see for a player, and how far it is from each one it could pull right now */
type View = NonNullable<Reply["stasis"]>;

interface PendingQuery {

	/** What each site with a matching name has answered so far, by bot UUID */
	views: Map<string, View>;

	/** How many peers have answered, whether or not their site has a matching name */
	answered: number;

	/** How many peers received the question */
	expected: number;

	/** Stop waiting and decide with the answers collected so far */
	finish: () => void;

}

interface Survey {

	/** How many pearls the player has at this bot's site */
	local: number;

	/** How many pearls the player has across every site that was asked. A chamber several bots can see counts once. */
	total: number;

	/** The bot that is closest to a pearl it could pull, or null if nobody can pull one */
	nearest: { botId: string, distance: number } | null;

}

/**
 * Each bot looks after one site, and sites on the same server can share a location name.
 *
 * A request addressed to one bot — a whisper, a Discord or HTTP load — is served at that bot's
 * site. One that names a location in public chat reaches every site with that name, and is
 * routed to whichever of them is nearest to one of the player's pearls.
 *
 * Limits are each bot's own config. The only thing sites ask each other is which pearls they
 * can see, to route a load and to count a player's pearls across sites.
 */
export class ClusterManager {

	private static readonly logger = new Logger(chalk.hex("#00c5b5")("CLUSTER"));

	/** How long to wait for peers to say what they can see before deciding without them */
	private static readonly QUERY_TIMEOUT_MS = 1_500;

	/** How long a claim keeps the other bots from handling the same event */
	private static readonly CLAIM_TTL_S = "5";

	/** Questions this bot has asked its peers and is still collecting answers to, by query id */
	private static readonly queries = new Map<string, PendingQuery>();

	/** This bot's place on the cluster, or null while it is not connected to a server */
	private static get self() {
		const id = MinecraftClient.session?.selectedProfile.id;
		const host = MinecraftClient.host;
		if (!id || !host) return null;
		return {
			id: normalizeUUID(id),
			host,
			channel: `stasisproxy:cluster:${ host }`
		} as const;
	}

	/**
	 * Take an event for this bot. Bots that hear the same chat or watch the same pearls each get
	 * the event — the first to claim it handles it.
	 * @param event What identifies the event, the same on every bot that witnessed it
	 * @returns Whether this bot should handle the event
	 */
	public static async claim(...event: string[]) {
		const self = this.self;
		if (!self) return true;

		// Without Redis there are no peers to coordinate with, so act alone
		return await redis.set(`stasisproxy:stasis:claim:${ self.host }:${ event.join(":") }`, self.id, "EX", this.CLAIM_TTL_S, "NX")
			.then(result => result === "OK")
			.catch(() => true);
	}

	/**
	 * What to append to a site's pearl count when the player has more pearls at other sites.
	 * @param local The count at this site
	 * @param total The count across every site
	 * @returns " (N total)", or nothing when every pearl is at this site
	 */
	public static totalSuffix(local: number, total: number) {
		return total > local ? ` (${ total } total)` : "";
	}

	/**
	 * Count a player's pearls at this site and across the sites that share a name with it, and
	 * find the bot that could pull one soonest.
	 * @param playerUuid The UUID of the player who owns the pearls
	 * @param names The location names to ask about; any site with one of them is counted
	 */
	public static async survey(playerUuid: string, names = STASIS_LOCATION_NAMES): Promise<Survey> {
		const self = this.self;
		if (!self) return { local: 0, total: 0, nearest: null };

		const [ mine, theirs ] = await Promise.all([ this.view(playerUuid), this.ask(self, playerUuid, names) ]);

		const chambers = new Set<string>();
		let nearest: Survey["nearest"] = null;
		for (const [ botId, view ] of theirs.set(self.id, mine)) {
			for (const { id, distance } of view) {
				chambers.add(id);
				if (distance !== null && (!nearest || distance < nearest.distance)) nearest = { botId, distance };
			}
		}

		return { local: mine.length, total: chambers.size, nearest };
	}

	/**
	 * Load a player's pearl at this site.
	 * @param playerUuid The UUID of the player who owns the pearl
	 * @returns What to tell the player, or null if this site has no pearl of theirs to load
	 */
	public static async pull(playerUuid: string) {

		// The other sites are only asked for the sake of the reply, so the bot sets off without waiting on them
		const [ remaining, { total } ] = await Promise.all([ StasisManager.enqueue(playerUuid), this.survey(playerUuid) ]);
		if (remaining === -1) return null;

		return `Loading your pearl, you have ${ remaining } / ${ STASIS_SITE_MAX } pearls remaining${ this.totalSuffix(remaining, total - 1) }.`;
	}

	/**
	 * Load a player's pearl at this site for a request that was routed here, and whisper them
	 * the outcome — the bot that heard the request is not the one answering it.
	 * @param playerUuid The UUID of the player who owns the pearl
	 * @returns Whether this site had a pearl to load
	 */
	public static async serve(playerUuid: string) {
		const message = await this.pull(playerUuid);
		const player = Object.values(MinecraftClient.bot.players).find(player => player.uuid === playerUuid);
		if (message && player) MinecraftClient.chat.whisper(player, message);
		return message !== null;
	}

	/**
	 * Load a player's pearl at whichever site with the given name is nearest to one.
	 * @param playerUuid The UUID of the player who owns the pearl
	 * @param name The location name the player asked for
	 * @returns Whether any site had a pearl to load
	 */
	public static async load(playerUuid: string, name: string) {
		const self = this.self;
		const { nearest } = await this.survey(playerUuid, [ name ]);
		if (!self || !nearest) return false;
		if (nearest.botId === self.id) return await this.serve(playerUuid);

		this.logger.log(`Routing load for player ${ chalk.cyan(playerUuid) } to peer ${ chalk.cyan(nearest.botId) }`, chalk.dim(`closest=${ nearest.distance.toFixed(1) }m`));
		await redis.emit(self.channel, { type: "request-load", playerUuid, destinationUuid: nearest.botId, notify: true });
		return true;
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
		const named = query.locations.some(name => STASIS_LOCATION_NAMES.includes(name));
		await redis.emit(channel, { type: "stasis-reply", id: query.id, from: id, stasis: named ? await this.view(query.playerUuid) : null });
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
	private static ask(self: NonNullable<typeof ClusterManager.self>, playerUuid: string, names: string[]) {
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
			redis.emit(self.channel, { type: "stasis-query", id, from: self.id, playerUuid, locations: names })
				.then(receivers => {
					query.expected = receivers - 1;
					if (query.answered >= query.expected) finish();
				})
				.catch(finish);
		});
	}

}
