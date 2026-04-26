import type { Client as MinecraftClient } from "minecraft-protocol";
import type { Bot as Mineflayer } from "mineflayer";

/**
 * Execution context passed to every {@link ClientCommand.execute} call. Gives
 * the command access to the proxy client it came from, the upstream bot, and
 * the per-connection ServerClient (typed loosely to avoid a circular import).
 */
export interface ClientCommandContext {
	client: MinecraftClient;
	bot: Mineflayer;

	/** The owning {@link ServerClient}, exposed loosely to avoid circular imports. */
	serverClient: import("./ServerClient").ServerClient;
}

/**
 * Abstract base for commands that the proxy intercepts before they reach the
 * upstream server. Concrete subclasses are registered with a
 * {@link ClientCommandManager} on a per-connection basis.
 *
 * @example
 * class PingCommand extends ClientCommand {
 *     public readonly name = "ping";
 *     public execute() {
 *         // ...
 *     }
 * }
 */
export abstract class ClientCommand {

	/** The command keyword, without the leading `/`. */
	public abstract readonly name: string;

	/** Short human-readable description, displayed by future help/usage tooling. */
	public readonly description: string = "";

	/**
	 * Run the command. Tokens are everything after the command name, split on
	 * whitespace (no quoting). Throwing inside `execute` is caught by the
	 * manager and reported as a chat message to the client.
	 *
	 * @param args - Whitespace-split argument tokens (excluding the command name)
	 * @param ctx - Per-invocation context including the client and bot
	 */
	public abstract execute(args: string[], ctx: ClientCommandContext): void | Promise<void>;

}
