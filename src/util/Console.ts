import chalk from "chalk";
import type { Bot as Mineflayer } from "mineflayer";
import { createInterface, type Interface } from "readline";
import { Logger } from "./Logger";

export class Console {

	private readonly rl: Interface;

	constructor(private readonly bot: Mineflayer) {
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: chalk.gray("> ")
		});

		Logger.setRenderHook(() => this.rl.prompt(true));
		this.rl.prompt();

		this.rl.on("line", line => {
			const trimmed = line.trim();
			if (trimmed) bot.chat(trimmed);
			this.rl.prompt();
		});

		this.rl.on("close", () => {
			Logger.setRenderHook(null);
			bot.quit();
			process.exit(0);
		});
	}

}
