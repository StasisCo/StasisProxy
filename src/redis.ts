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
export const redisSub = new RedisClient(redisUrl, options);

/** Wire up connect / close logging for both clients */
function attach(name: string, client: RedisClient) {
	client.onconnect = () => logger.log(`${ name } connected`);
	client.onclose = err => logger.warn(`${ name } disconnected${ err ? `: ${ err.message }` : "" } — reconnecting`);
}
attach("commands", redis);
attach("subscribe", redisSub);

/**
 * Heartbeat — managed Redis providers close idle TCP sockets even when the
 * client thinks it's connected, which causes the *next* command to time out
 * before auto-reconnect kicks in. A periodic PING keeps the socket warm and
 * surfaces dead connections immediately so the auto-reconnect loop runs.
 */
const HEARTBEAT_MS = 30_000;
function heartbeat(name: string, client: RedisClient) {
	setInterval(() => {
		if (!client.connected) return;
		client.ping().catch(err => logger.warn(`${ name } ping failed: ${ err.message }`));
	}, HEARTBEAT_MS).unref();
}
heartbeat("commands", redis);
heartbeat("subscribe", redisSub);
