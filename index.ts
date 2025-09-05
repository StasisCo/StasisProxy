import { PrismaClient } from "@prisma/client";
import { Glob } from "bun";
import { Bot } from "./class/Bot";
import { StasisQueue } from "./class/StasisQueue";

// Connect to the database
export const prisma = new PrismaClient();

// Disconnect prisma on exit
process.once("beforeExit", () => prisma.$disconnect());

// Create and login the bot
const bot = await Bot.connect();

// Iterate over all files in modules folder
for await (const path of new Glob("modules/*.ts").scan()) {
	const module = await import(`./${ path }`);
	if (typeof module.default !== "function") continue;
	await module.default(bot);
}

// Start the pearl queue processor
bot.on("physicsTick", () => StasisQueue.process());