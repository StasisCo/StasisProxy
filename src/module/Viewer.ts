import chalk from "chalk";
import EventEmitter from "events";
import express from "express";
import { createServer, type Server as HttpServer } from "http";
import { join } from "path";
import { setupRoutes } from "prismarine-viewer/lib/common";
import { WorldView } from "prismarine-viewer/viewer";
import { Server as IoServer, type Socket } from "socket.io";
import z from "zod";
import { Client } from "~/class/Client";
import { Logger } from "~/class/Logger";
import { Module } from "~/class/Module";
import { getPatchedClient } from "~/webclient/patches";

const zConfigSchema = z.object({
	port: z
		.number()
		.default(80)
		.describe("HTTP port the viewer web server listens on"),
	viewDistance: z
		.number()
		.default(32)
		.describe("Chunk view distance streamed to viewer clients"),
	firstPerson: z
		.boolean()
		.default(false)
		.describe("Stream the bot's pitch so viewers see in first person"),
	prefix: z
		.string()
		.default("")
		.describe("URL prefix for the viewer routes (e.g. '/viewer')"),
	worldMinY: z
		.number()
		.default(-64)
		.describe("Minimum world Y; controls how far down the client meshes chunks"),
	worldMaxY: z
		.number()
		.default(320)
		.describe("Maximum world Y; controls how far up the client meshes chunks")
});

interface Vec3Like {
	x: number;
	y: number;
	z: number;
}

interface BoxGridPrimitive {
	type: "boxgrid";
	id: string;
	start: Vec3Like;
	end: Vec3Like;
	color: number;
	alwaysVisible?: boolean;
}
interface LinePrimitive {
	type: "line";
	id: string;
	points: Vec3Like[];
	color: number;
	alwaysVisible?: boolean;
}
interface PointsPrimitive {
	type: "points";
	id: string;
	points: Vec3Like[];
	color: number;
	size: number;
	alwaysVisible?: boolean;
}
type Primitive = BoxGridPrimitive | LinePrimitive | PointsPrimitive;

interface ViewerEvents {
	blockClicked: [ block: unknown, face: number, button: number ];
}

export default class Viewer extends Module<typeof zConfigSchema> {

	public override readonly zConfigSchema = zConfigSchema;

	private static readonly logger = new Logger(chalk.hex("#7CFC00")("VIEWER"));

	/** Public event bus — mirrors `bot.viewer` from prismarine-viewer. */
	public readonly events = new EventEmitter<ViewerEvents>();

	private http: HttpServer | null = null;
	private io: IoServer | null = null;
	private readonly sockets = new Set<Socket>();
	private readonly primitives = new Map<string, Primitive>();

	constructor() {
		super("Viewer");
	}

	public override onReady(): void {
		void this.start();
	}

	public override onDisable(): void {
		this.stop();
	}

	public override onConfigReload(): void {

		// Restart so port / viewDistance / prefix changes take effect.
		if (!this.enabled) return;
		this.stop();
		if (Client.bot.entity) void this.start();
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Primitive API (parity with bot.viewer.* from prismarine-viewer/mineflayer)
	// ──────────────────────────────────────────────────────────────────────────

	public erase(id: string): void {
		this.primitives.delete(id);
		this.broadcast("primitive", { id });
	}

	public drawBoxGrid(id: string, start: Vec3Like, end: Vec3Like, color = 0xFF0000, alwaysVisible = false): void {
		this.savePrimitive({ type: "boxgrid", id, start, end, color, alwaysVisible });
	}

	public drawLine(id: string, points: Vec3Like[], color = 0xff0000, alwaysVisible = false): void {
		this.savePrimitive({ type: "line", id, points, color, alwaysVisible });
	}

	public drawPoints(id: string, points: Vec3Like[], color = 0xff0000, size = 5, alwaysVisible = false): void {
		this.savePrimitive({ type: "points", id, points, color, size, alwaysVisible });
	}

	// ──────────────────────────────────────────────────────────────────────────
	// Internals
	// ──────────────────────────────────────────────────────────────────────────

	private savePrimitive(primitive: Primitive): void {
		this.primitives.set(primitive.id, primitive);
		this.broadcast("primitive", primitive);
	}

	private broadcast(event: string, payload: unknown): void {
		for (const socket of this.sockets) socket.emit(event, payload);
	}

	private async start(): Promise<void> {
		if (this.http) return;

		const { port, prefix } = this.config;
		const app = express();
		const http = createServer(app);
		const io = new IoServer(http, { path: prefix + "/socket.io" });

		// Serve our patched bundle + custom HTML/overrides BEFORE setupRoutes,
		// so Express's first-match wins over prismarine-viewer's static dir.
		const { js: patchedJs } = await getPatchedClient();
		const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;

		app.get(`${ base }/index.js`, (_req, res) => {
			res.type("application/javascript").send(patchedJs);
		});
		app.get(`${ base }/config.js`, (_req, res) => {
			const { worldMinY, worldMaxY } = this.config;
			res.type("application/javascript").send(
				`window.__stasisMinY=${ worldMinY };window.__stasisMaxY=${ worldMaxY };`
			);
		});
		app.use(base || "/", express.static(join(import.meta.dir, "..", "webclient")));

		setupRoutes(app, prefix);

		io.on("connection", socket => this.handleConnection(socket));

		http.listen(port, () => {
			Viewer.logger.log(`Viewer web server listening on ${ chalk.cyan(`0.0.0.0:${ port }`) }`);
		});

		this.http = http;
		this.io = io;
	}

	private stop(): void {
		for (const socket of this.sockets) socket.disconnect(true);
		this.sockets.clear();
		this.primitives.clear();

		this.io?.close();
		this.io = null;

		this.http?.close();
		this.http = null;
	}

	private handleConnection(socket: Socket): void {
		const bot = Client.bot;
		socket.emit("version", bot.version);
		this.sockets.add(socket);

		const address = socket.handshake.address;
		Viewer.logger.log(`Client ${ chalk.cyan(socket.id) } connected from ${ chalk.cyan(address) }`);

		const worldView = new WorldView(bot.world, this.config.viewDistance, bot.entity.position, socket);
		worldView.init(bot.entity.position);

		worldView.on("blockClicked", (block: unknown, face: number, button: number) => {
			this.events.emit("blockClicked", block, face, button);
		});

		// Replay every primitive so newly-connected viewers see existing overlays.
		for (const primitive of this.primitives.values()) socket.emit("primitive", primitive);

		const onMove = () => {
			const packet: { pos: unknown; yaw: number; addMesh: boolean; pitch?: number } = {
				pos: bot.entity.position,
				yaw: bot.entity.yaw,
				addMesh: true
			};
			if (this.config.firstPerson) packet.pitch = bot.entity.pitch;
			socket.emit("position", packet);
			worldView.updatePosition(bot.entity.position);
		};

		bot.on("move", onMove);
		worldView.listenToBot(bot);

		socket.on("disconnect", reason => {
			bot.removeListener("move", onMove);
			worldView.removeListenersFromBot(bot);
			this.sockets.delete(socket);
			Viewer.logger.log(`Client ${ chalk.cyan(socket.id) } disconnected ${ chalk.dim(`(${ reason })`) }`);
		});
	}

}
