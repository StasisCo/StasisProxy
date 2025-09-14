import chalk from "chalk";
import dayjs from "dayjs";
import { format } from "util";

export class Logger {

	/** Singleton instance of the Logger class */
	private static instance = new Logger();

	/**
	 * Format a log message with a timestamp and optional prefix
	 * @param args - The arguments to pass to console.log
	 * @returns {string} The formatted log message
	 */
	private format(...args: unknown[]): string {
		const timestamp = chalk.gray(dayjs().format("MM/DD/YYYY hh:mm:ss A"));
		const prefixLine = [ this.prefix ? [ chalk.underline(timestamp), chalk.gray("│"), this.prefix ] : chalk.underline(timestamp) ].flat().filter(Boolean).join(" ");
		return format(prefixLine, chalk.gray("│"), ...args);
	}
	
	/** 
     * When used as an instance, the prefix is used to identify the source of the log 
     * @param prefix - Optional prefix for the logger instance
     */
	constructor(private readonly prefix?: string) { }
    
	// Static methods to log messages with the singleton instance
	public static log = this.instance.log.bind(this.instance);
	public static warn = this.instance.warn.bind(this.instance);
	public static error = this.instance.error.bind(this.instance);

	/** Print a message to the console and log file */
	public log(...args: unknown[]) {
		console.log(chalk.blue("ℹ️"), this.format(...args));
	}
    
	/** Print a warning message to the console and log file */
	public warn(...args: unknown[]) {
		console.warn(chalk.yellow("⚠️"), this.format(...args));
	}
	
	/** Print an error message to the console and log file */
	public error(...args: unknown[]) {
		console.error(chalk.red("❌"), this.format(...args));
	}

}