import chalk from "chalk";
import dayjs from "dayjs";
import stripAnsi from "strip-ansi";
import { format } from "util";

export class Logger {

	/** Singleton instance of the Logger class */
	private static instance = new Logger();

	private static prefixLength = 0;

	private static onRender: (() => void) | null = null;

	public static setRenderHook(callback: (() => void) | null) {
		Logger.onRender = callback;
	}

	/**
	 * Format a log message with a timestamp and optional prefix
	 * @param args - The arguments to pass to console.log
	 * @returns {string} The formatted log message
	 */
	private format(...args: unknown[]): string {
		const timestamp = chalk.gray(dayjs().format("MM/DD/YYYY hh:mm:ss A"));
		const paddedPrefix = this.prefix ? this.prefix + " ".repeat(Math.max(0, Logger.prefixLength - stripAnsi(this.prefix).length)) : undefined;
		const prefixLine = [ paddedPrefix ? [ chalk.underline(timestamp), chalk.gray("|"), paddedPrefix ] : chalk.underline(timestamp) ].flat().filter(Boolean).join(" ");
		return format(prefixLine, chalk.gray("|"), format(...args).replace(/\n/g, `\n${ " ".repeat(stripAnsi(timestamp).length + 4) }${ chalk.gray("|") } ${ paddedPrefix } ${ chalk.gray("|") } `));
	}
	
	/** 
     * When used as an instance, the prefix is used to identify the source of the log 
     * @param prefix - Optional prefix for the logger instance
     */
	constructor(private readonly prefix?: string) {
		Logger.prefixLength = Math.max(Logger.prefixLength, stripAnsi(prefix ?? "").length);
	}
    
	// Static methods to log messages with the singleton instance
	public static log = this.instance.log.bind(this.instance);
	public static warn = this.instance.warn.bind(this.instance);
	public static error = this.instance.error.bind(this.instance);

	/** Print a message to the console and log file */
	public log(...args: unknown[]) {
		Logger.clearLine();
		console.log(chalk.blue("ℹ️ "), this.format(...args));
		Logger.onRender?.();
	}
    
	/** Print a warning message to the console and log file */
	public warn(...args: unknown[]) {
		Logger.clearLine();
		console.warn(chalk.yellow("⚠️ "), this.format(...args));
		Logger.onRender?.();
	}
	
	/** Print an error message to the console and log file */
	public error(...args: unknown[]) {
		Logger.clearLine();
		console.error(chalk.red("❌"), this.format(...args));
		Logger.onRender?.();
	}

	private static clearLine() {
		if (Logger.onRender && process.stdout.isTTY) {
			process.stdout.write("\r\x1b[K");
		}
	}
}