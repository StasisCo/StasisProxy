import { PrismaPg } from "@prisma/adapter-pg";
import chalk from "chalk";
import { Logger } from "./class/Logger";
import { PrismaClient } from "./generated/prisma/client";

const logger = new Logger(chalk.hex("#a990ec")("PRISMA"));

// // Apply pending migrations on startup (creates tables if DB is empty)
// const migrate = Bun.spawnSync([ "bunx", "prisma", "migrate", "deploy" ]);
// if (migrate.exitCode === 0) {
// 	logger.log("Database migrations applied");
// } else {
// 	logger.error("Database migration failed:\n", migrate.stderr.toString());
// 	process.exit(1);
// }

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });