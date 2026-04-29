import { RedisClient } from "bun";
import chalk from "chalk";
import z from "zod";
import { Logger } from "./class/Logger";

const redisUrl = z.string().parse(process.env.REDIS_URL);

export const redis = new RedisClient(redisUrl);

/** Dedicated client for subscriptions — Bun's RedisClient cannot mix pub/sub with regular commands on the same connection */
export const redisSub = new RedisClient(redisUrl);

export const logger = new Logger(chalk.hex("#ff4438")("REDIS"));