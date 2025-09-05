import { RedisClient } from "bun";
import z from "zod";

export const redis = new RedisClient(z.string().parse(process.env.REDIS_URL));