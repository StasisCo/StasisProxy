import { RedisClient } from "bun";
import chalk from "chalk";
import stringify from "fast-json-stable-stringify";
import prettyMilliseconds from "pretty-ms";
import z from "zod";
import { Logger } from "./class/Logger";

type SubListener<T = string> = (message: T, channel: string) => void;

const logger = new Logger(chalk.hex("#ff4438")("REDIS"));

/** Redis client options */
const options: ConstructorParameters<typeof RedisClient>[1] = {
	maxRetries: 1_000,
	connectionTimeout: 30_000
};

// Validate REDIS_URL
const { data: redisUrl, success, error } = z.string().safeParse(process.env.REDIS_URL);
if (!success) {
	logger.error("Invalid REDIS_URL:", error);
	process.exit(1);
}

// In-memory tracking of Redis channel subscriptions for automatic resubscription on reconnect.
const subscriptions = new Map<string, Set<SubListener>>();

// Flag to track if the subscriber client has ever successfully connected. 
let subHasConnected = false;

// Start the connection process immediately.
const now = Date.now();
const url = new URL(redisUrl);
logger.log("Connecting to Redis:", chalk.cyan.underline(url.hostname) + "...");

// Create the Redis clients
const kvClient = new RedisClient(redisUrl, options);
const psClient = new RedisClient(redisUrl, options);

// Expose the unified Redis interface with JSON parsing/stringifying and subscription tracking
export const redis = { ...kvClient, emit, get, off, on, set, logger };

// Handle connection events for both clients
kvClient.onconnect = () => logger.log("Redis connected in", chalk.yellow(prettyMilliseconds(Date.now() - now)));

psClient.onclose = err => logger.warn(`Sub connection closed: ${ err ? err.message : "no error" }`);

kvClient.onclose = err => logger.warn(`Connection closed: ${ err ? err.message : "no error" }`);

psClient.onconnect = () => {

	if (!subHasConnected) return subHasConnected = true;

	// Reconnect — replay all tracked subscriptions
	for (const [ channel, listeners ] of subscriptions) {
		for (const listener of listeners) {
			psClient.subscribe(channel, listener)
				.then(() => logger.log(`Re-subscribed to ${ chalk.cyan(channel) }`))
				.catch(err => logger.warn(`Failed to re-subscribe to ${ chalk.cyan(channel) }: ${ err.message }`));
		}
	}

};

/**
 * Get a value from Redis and parse it as JSON
 * @param key The key to get
 * @returns The parsed value, or null if the key does not exist
 */
async function get<T extends keyof Redis.Schema>(key: T) {
	return await kvClient.get(key)
		.then(res => res ? JSON.parse(res) as Redis.ValueOf<T> : null);
}

/**
 * Set a value in Redis, stringifying it as JSON if it's not already a string
 * @param key The key to set
 * @param value The value to set; if not a string, it will be stringified as JSON
 * @param options Additional options to pass to the Redis SET command, e.g. "EX", "60" for a 60-second TTL
 * @returns The result of the Redis SET command, typically "OK" if successful
 */
async function set<T extends keyof Redis.Schema>(key: T, value: Redis.ValueOf<T> | string, ...options: string[]) {
	return await kvClient.set(key, stringify(value), ...options);
}

/**
 * Subscribe to a Redis channel with the given listener, and track the subscription for automatic resubscription on reconnect. 
 * If the same listener is already subscribed to the channel, it will not be added again.
 * @param channel The Redis channel to subscribe to
 * @param listener The function to call when a message is received on the channel; it receives the message and channel as arguments
 * @returns A promise that resolves when the subscription is successful
 */
async function on<T extends Redis.ValidChannel>(channel: T, listener: SubListener<Redis.MessageOf<T>>) {
	const set = subscriptions.get(channel) ?? new Set();
	set.add(listener as SubListener);
	subscriptions.set(channel, set);
	return psClient.subscribe(channel, (raw: string, ch: string) => listener(JSON.parse(raw) as Redis.MessageOf<T>, ch));
}

/**
 * Unsubscribe from a Redis channel for the given listener, or all listeners if no specific listener is provided.
 * If a listener is provided, only that listener will be unsubscribed from the channel;
 * if no listener is provided, all listeners for the channel will be unsubscribed and the channel will be removed from tracking.
 * @param channel The Redis channel to unsubscribe from
 * @param listener Optional specific listener to unsubscribe; if not provided, all listeners for the channel will be unsubscribed
 * @returns A promise that resolves when the unsubscription(s) are successful
 */
async function off(channel: Redis.ValidChannel, listener?: SubListener) {
	const set = subscriptions.get(channel);
	if (!set) return;
	const targets = listener ? [ listener ] : [ ...set ];
	for (const fn of targets) {
		set.delete(fn);
		await psClient.unsubscribe(channel, fn);
	}
	if (set.size === 0) subscriptions.delete(channel);
}

/**
 * Publish a message to a Redis channel, stringifying the data as JSON if it's not already a string. 
 * This is a wrapper around the Redis client's publish method that adds JSON stringification and logging.
 * @param channel The Redis channel to publish to
 * @param data The data to publish; if not a string, it will be stringified as JSON
 * @returns The number of subscribers that received the message
 */
async function emit<T extends Redis.ValidChannel>(channel: T, data: Redis.MessageOf<T>) {
	return kvClient.publish(channel, typeof data === "string" ? data : stringify(data));
}

