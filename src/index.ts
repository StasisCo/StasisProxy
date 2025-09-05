import { Client } from "./app/Client";
import { Console } from "./util/Console";

// Initialize the console interface if running in a TTY environment
if (process.stdin.isTTY) Client.console = new Console(Client.bot);