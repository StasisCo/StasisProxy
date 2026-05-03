import chalk from "chalk";
import express, { type Application } from "express";
import { Logger } from "~/class/Logger";

export class HttpServer {

	private static readonly logger = new Logger(chalk.hex("#7CFC00")("RESTAPI"));

	// The instance of the express server
	protected static readonly app = express();

	// The listener for the server
	protected static listener: ReturnType<typeof HttpServer.app.listen>;
    
	// The port to listen on
	protected static PORT = parseInt(process.env.HTTP_PORT ?? "3000");

	// The host to listen on
	protected static readonly HOST = "0.0.0.0";

	/**
	 * Start the Bubble server
	 */
	public static async start() {

		// Start the bubble server, retrying on next port if bind fails
		const tryListen = (): Promise<void> => new Promise<void>((resolve, reject) => {

			HttpServer.listener = HttpServer.app

				// Attempt to start the server
				.listen(HttpServer.PORT, HttpServer.HOST, function() {
					HttpServer.logger.log("HTTP server started on", chalk.cyan.underline(`http://${ HttpServer.HOST }:${ HttpServer.PORT }`));
					resolve();
				})

				// If the server fails to start, retry on next port for bind errors
				.on("error", (error: { code: string }) => {
					if (error.code === "EADDRINUSE" || error.code === "EACCES") {
						HttpServer.logger.warn(`Port ${ HttpServer.PORT } unavailable, trying ${ HttpServer.PORT + 1 }...`);
						HttpServer.PORT++;
						resolve(tryListen());
					} else {
						reject(error.code);
					}
				});

		});

		return tryListen();
		
	}

	/**
	 * Stop the Bubble server
	 */
	public static stop() {
		return new Promise<void>(function(resolve) {
			HttpServer.logger.log("Server shutting down");
			HttpServer.listener.close(() => resolve());
		});
	}

	/**
	 * Wrap an express method to catch errors asynchronously
	 * @param method The express method to wrap
	 */
	private static wrap(method: typeof HttpServer.app.use) {
		return function(path: string, handler: (req: express.Request, res: express.Response, next: express.NextFunction) => unknown) {
			method.call(HttpServer.app, path, async function(req, res, next) {
				try {
					await handler(req, res, next);
				} catch (error) {
					next(error);
				}
			} as Application);
		};
	}
    
	public static DELETE = HttpServer.wrap(HttpServer.app.delete);
	public static GET = HttpServer.wrap(HttpServer.app.get);
	public static PATCH = HttpServer.wrap(HttpServer.app.patch);
	public static POST = HttpServer.wrap(HttpServer.app.post);
	public static PUT = HttpServer.wrap(HttpServer.app.put);
    
}