declare module "prismarine-viewer/lib/common" {
	import type { Express } from "express";

	export function setupRoutes(app: Express, prefix?: string): void;
}

declare module "prismarine-viewer/viewer" {
	import type EventEmitter from "events";
    import type { Bot } from "mineflayer";

	interface Vec3Like {
		x: number;
		y: number;
		z: number;
	}

	interface MinimalEmitter {
		emit(event: string, ...args: unknown[]): boolean;
		on(event: string, listener: (...args: never[]) => void): unknown;
	}

	export class WorldView extends EventEmitter {
		constructor(world: Bot["world"], viewDistance: number, position?: Vec3Like, emitter?: MinimalEmitter | null);

		world: Bot["world"];
		viewDistance: number;
		loadedChunks: Record<string, true>;
		lastPos: Vec3Like;
		emitter: MinimalEmitter;

		init(pos: Vec3Like): Promise<void>;
		listenToBot(bot: Bot): void;
		removeListenersFromBot(bot: Bot): void;
		updatePosition(pos: Vec3Like, force?: boolean): Promise<void>;
		loadChunk(pos: Vec3Like): Promise<void>;
		unloadChunk(pos: Vec3Like): void;
	}
}
