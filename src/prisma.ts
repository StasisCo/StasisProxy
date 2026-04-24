import { PrismaPg } from "@prisma/adapter-pg";
import { $ } from "bun";
import chalk from "chalk";
import { Logger } from "./class/Logger";
import { PrismaClient } from "./generated/prisma/client";

const logger = new Logger(chalk.hex("#a990ec")("PRISMA"));

// Apply pending migrations on startup (creates tables if DB is empty)
logger.log("Checking required database migrations...");

const migrate = $`bunx prisma migrate deploy`;

for await (const line of migrate.lines()) if (line) logger.log(line);

const result = await migrate;
if (result.exitCode !== 0) {
	logger.error("Failed to apply database migrations. Exiting...");
	process.exit(1);
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });