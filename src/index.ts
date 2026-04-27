import { Client } from "./class/Client";
import { Console } from "./class/Console";
import { Module } from "./class/Module";

// Initialize the console interface if running in a TTY environment
if (process.stdin.isTTY) Client.console = new Console(Client.bot);

// Load and bind modules (deferred until Client class is fully initialized to avoid TDZ)
Module.init();