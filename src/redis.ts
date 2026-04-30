import { RedisClient } from "bun";
import chalk from "chalk";
import z from "zod";
import { Logger } from "./class/Logger";

const redisUrl = z.string().parse(process.env.REDIS_URL);

export const logger = new Logger(chalk.hex("#ff4438")("REDIS"));

/**
 * Shared options for all Redis connections. Tuned for managed/SaaS Redis
 * (Upstash, Redis Cloud, Aiven, etc.) where intermediate load balancers
 * silently drop idle TCP connections after 60–300s.
 */
const options = {

	/** Disable client-side idle close — we manage liveness with a heartbeat */
	idleTimeout: 0,

	/** Reconnect automatically on disconnect */
	autoReconnect: true,

	/** Allow many reconnect attempts before giving up */
	maxRetries: 1_000,

	/** Long initial connect window for cold SaaS endpoints */
	connectionTimeout: 30_000
} as const;

export const redis = new RedisClient(redisUrl, options);

/** Dedicated client for subscriptions — Bun's RedisClient cannot mix pub/sub with regular commands on the same connection */
const rawSub = new RedisClient(redisUrl, options);

/**
 * Subscription registry. Upstash (and most managed Redis providers) reset
 * subscriptions on reconnect — the client thinks it is still subscribed but
 * silently receives nothing. We keep our own registry so we can replay every
 * `subscribe` call whenever the underlying socket reconnects.
 */
type SubListener = (message: string, channel: string) => void;
const subscriptions = new Map<string, Set<SubListener>>();

/**
 * Wrapper around `rawSub` that tracks subscriptions and replays them on
 * reconnect. API is intentionally identical to `RedisClient.subscribe` /
 * `RedisClient.unsubscribe` so existing call sites do not need to change.
 */
export const redisSub = {
	get connected() {
		return rawSub.connected;
	},
	async subscribe(channel: string, listener: SubListener) {
		const set = subscriptions.get(channel) ?? new Set();
		set.add(listener);
		subscriptions.set(channel, set);
		return rawSub.subscribe(channel, listener);
	},
	async unsubscribe(channel: string, listener?: SubListener) {
		const set = subscriptions.get(channel);
		if (!set) return;
		const targets = listener ? [ listener ] : [ ...set ];
		for (const fn of targets) {
			set.delete(fn);
			await rawSub.unsubscribe(channel, fn);
		}
		if (set.size === 0) subscriptions.delete(channel);
	}
};

/** Wire up connect / close logging for both clients */
function attach(name: string, client: RedisClient) {
	client.onconnect = () => logger.log(`${ name } connected`);
	client.onclose = err => logger.warn(`${ name } disconnected${ err ? `: ${ err.message }` : "" } — reconnecting`);
}
attach("commands", redis);
attach("subscribe", rawSub);

/**
 * Replay all known subscriptions whenever the subscribe client *re*connects.
 * We skip the very first connect because explicit `subscribe()` calls handle
 * the initial subscription themselves — replaying then would be redundant.
 */
let subHasDisconnected = false;
const previousSubOnClose = rawSub.onclose;
rawSub.onclose = function(this: RedisClient, err) {
	subHasDisconnected = true;
	previousSubOnClose?.call(this, err);
};
const previousSubOnConnect = rawSub.onconnect;
rawSub.onconnect = function(this: RedisClient, ...args) {
	previousSubOnConnect?.call(this, ...args);
	if (!subHasDisconnected || subscriptions.size === 0) return;
	for (const [ channel, listeners ] of subscriptions) {
		for (const listener of listeners) {
			rawSub.subscribe(channel, listener)
				.then(() => logger.log(`Re-subscribed to ${ chalk.cyan(channel) }`))
				.catch(err => logger.warn(`Failed to re-subscribe to ${ chalk.cyan(channel) }: ${ err.message }`));
		}
	}
};

/**
 * Heartbeat — managed Redis providers close idle TCP sockets even when the
 * client thinks it's connected, which causes the *next* command to time out
 * before auto-reconnect kicks in. A periodic PING keeps the socket warm and
 * surfaces dead connections immediately so the auto-reconnect loop runs.
 *
 * Upstash specifically closes idle connections at exactly 300s, so we ping
 * well below that threshold (and also below typical NAT/load-balancer windows).
 */
const HEARTBEAT_MS = 30_000;
function heartbeat(name: string, client: RedisClient) {
	setInterval(() => {
		if (!client.connected) return;
		client.ping().catch(err => logger.warn(`${ name } ping failed: ${ err.message }`));
	}, HEARTBEAT_MS).unref();
}
heartbeat("commands", redis);
heartbeat("subscribe", rawSub);
