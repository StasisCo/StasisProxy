import { PrismaPg } from "@prisma/adapter-pg";
import { $ } from "bun";
import chalk from "chalk";
import z from "zod";
import { Logger } from "./class/Logger";
import { PrismaClient } from "./generated/prisma/client";

const logger = new Logger(chalk.hex("#a990ec")("PRISMA"));

// Validate DATABASE_URL at startup
const { data: connectionString, success, error } = z.string().safeParse(process.env.DATABASE_URL);
if (!success) {
	logger.error("Invalid DATABASE_URL:", error);
	process.exit(1);
}

// Apply pending migrations on startup (creates tables if DB is empty)
if (!process.argv.includes("--skip-migrations")) {
	logger.log("Checking required database migrations...");
	
	const migrate = $`bunx prisma migrate deploy`.quiet().throws(false);
	
	for await (const line of migrate.lines()) if (line) logger.log(line);
	
	const result = await migrate;
	if (result.exitCode !== 0) {
		logger.error("Failed to apply database migrations.");
		process.exit(1);
	}
	
}

// Log the database host for better visibility. The connection string may contain
const url = new URL(connectionString);
logger.log("Connecting to Postgres", chalk.cyan(url.username), chalk.dim("@"), chalk.cyan.underline(url.host) + "...");
const now = Date.now();

// Init adapter
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });

prisma.$connect().then(() => logger.log("Connected to Postgres", chalk.yellow(`${ Date.now() - now }ms`))).catch(err => {
	logger.error("Postgres connection error:", err);
	process.exit(1);
});