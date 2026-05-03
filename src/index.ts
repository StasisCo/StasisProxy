import { Console } from "./class/Console";
import { DiscordClient } from "./client/discord/DiscordClient";
import { MinecraftClient } from "./client/minecraft/MinecraftClient";
import { Module } from "./client/minecraft/Module";
import { HttpServer } from "./server/http/HttpServer";

// Initialize Discord client and connect to Discord
DiscordClient.init();

// Start the HTTP server
HttpServer.start();

// Initialize the console interface if running in a TTY environment
if (process.stdin.isTTY) MinecraftClient.console = new Console(MinecraftClient.bot);

// Load and bind modules
Module.init();
