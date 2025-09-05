import { PrismaClient } from "@prisma/client";
import { Glob } from "bun";
import { Bot } from "./class/Bot";
import { Logger } from "./class/Logger";
import { StasisQueue } from "./class/StasisQueue";
import * as config from "./config";
import { printObject } from "./utils/format";

// Connect to the database
export const prisma = new PrismaClient();

// Disconnect prisma on exit
process.once("beforeExit", () => prisma.$disconnect());

Logger.log("Loaded configuration:");
printObject(config);

// Create and login the bot
const bot = await Bot.connect();

// Load core modules and modules
for await (const path of new Glob("src/{core,modules}/**/*.ts").scan()) {
	const module = await import(`../${ path }`);
	if (typeof module.default === "function") await module.default(bot);
}

// Start the pearl queue processor
bot.on("physicsTick", () => void StasisQueue.tick());