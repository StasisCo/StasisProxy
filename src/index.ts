import { Client } from "./class/Client";
import { Console } from "./class/Console";

import "./utils";

// Initialize the console interface if running in a TTY environment
if (process.stdin.isTTY) Client.console = new Console(Client.bot);