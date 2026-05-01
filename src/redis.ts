import { RedisClient } from "bun";
import chalk from "chalk";
import prettyMilliseconds from "pretty-ms";
import z from "zod";
import { Logger } from "./class/Logger";

export const logger = new Logger(chalk.hex("#ff4438")("REDIS"));

// Validate REDIS_URL up front so downstream code can assume it's well-formed.
const { data: redisUrl, success, error } = z.string().safeParse(process.env.REDIS_URL);
if (!success) {
	logger.error("Invalid REDIS_URL:", error);
	process.exit(1);
}

const url = new URL(redisUrl);
logger.log("Connecting to Redis:", chalk.cyan.underline(url.host) + "...");

/**
 * Shared options for all Redis connections. Tuned for managed/SaaS Redis
 * (Upstash, Redis Cloud, Aiven, etc.) where intermediate load balancers
 * silently drop idle TCP connections after 60–300s.
 */
const options = {
	maxRetries: 1_000,
	connectionTimeout: 30_000
} satisfies Bun.RedisOptions;

type SubListener = (message: string, channel: string) => void;

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

function createClient({ log, onReconnect }: { log?: boolean; onReconnect?: () => void } = {}): RedisClient {
	const now = Date.now();
	const client = new RedisClient(redisUrl, options);
	let hasDisconnected = false;

	client.onconnect = () => {
		if (log) logger.log("Redis connected in", chalk.yellow(prettyMilliseconds(Date.now() - now)));
		if (hasDisconnected) onReconnect?.();
	};
	client.onclose = err => {
		hasDisconnected = true;
		if (log) logger.warn(`Connection closed: ${ err ? err.message : "no error" }`);
	};

	setInterval(() => {
		if (!client.connected) return;
		client.ping().catch(err => {
			if (log) logger.warn(`Ping failed: ${ err.message }`);
		});
	}, HEARTBEAT_MS).unref();

	return client;
}

export const redis = createClient({ log: true });

/**
 * Subscription registry. Upstash (and most managed Redis providers) reset
 * subscriptions on reconnect — the client thinks it is still subscribed but
 * silently receives nothing. We keep our own registry so we can replay every
 * `subscribe` call whenever the underlying socket reconnects.
 *
 * Bun's RedisClient cannot mix pub/sub with regular commands on the same
 * connection, so we use a dedicated client here.
 */
const subscriptions = new Map<string, Set<SubListener>>();

const rawSub = createClient({
	onReconnect: () => {
		for (const [ channel, listeners ] of subscriptions) {
			for (const listener of listeners) {
				rawSub.subscribe(channel, listener)
					.then(() => logger.log(`Re-subscribed to ${ chalk.cyan(channel) }`))
					.catch(err => logger.warn(`Failed to re-subscribe to ${ chalk.cyan(channel) }: ${ err.message }`));
			}
		}
	}
});

/**
 * Wrapper around the subscribe client that tracks subscriptions and replays
 * them on reconnect. API is intentionally identical to `RedisClient.subscribe`
 * / `RedisClient.unsubscribe` so existing call sites do not need to change.
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
