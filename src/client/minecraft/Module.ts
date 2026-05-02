import { readdir } from "fs/promises";
import z from "zod";
import { ConfigManager } from "~/manager/ConfigManager";
import { MinecraftClient } from "./MinecraftClient";

export abstract class Module<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {

	public static readonly modules = new Map<string, Module>();

	public static get<T extends Module>(name: string): T {
		const module = this.modules.get(name) as T;
		if (!module) throw new Error(`Module ${ name } not registered`);
		return module;
	}

	/** Loads all modules from src/module, binds the packet listener, and schedules onReady/onTick. */
	public static init() {
		MinecraftClient.bot._client.on("packet", (data, { name }) => {
			for (const module of Module.modules.values()) {
				if (!module.enabled) continue;
				if (module.onPacketReceive) module.onPacketReceive({ name: name as keyof Packets.Schema, data });
			}
		});

		void Module.load();
	}

	private static async load() {
		for (const file of await readdir("src/client/minecraft/module", { withFileTypes: true, recursive: true })) {
			if (!file.isFile()) continue;
			if (!file.name.endsWith(".ts") && !file.name.endsWith(".js")) continue;
			await import(`./module/${ file.name }`).then(module => {
				const instance = new module.default() as Module;
				const { enabled, config } = ConfigManager.initModule(instance.name, instance.zConfigSchema);
				instance.config = config;
				instance._enabled = enabled;
				Module.modules.set(module.default.name, instance);
			}).catch(err => console.error("Failed to load module:", err));
		}

		// Re-parse each module's config when config.yml changes on disk
		ConfigManager.onReload(() => {
			for (const m of Module.modules.values()) {
				try {
					const { enabled, config } = ConfigManager.initModule(m.name, m.zConfigSchema);
					m.config = config;
					m.onConfigReload?.();
					if (m._enabled !== enabled) {
						m._enabled = enabled;
						if (enabled) {
							m.onEnable?.();
							if (MinecraftClient.bot.entity) m.onReady?.();
						} else {
							m.onDisable?.();
						}
					}
				} catch (err) {
					console.error(`Failed to reload config for module ${ m.name }:`, err);
				}
			}
		});

		Module.fireReady();
	}

	private static fireReady() {
		const ready = () => {

			// Call onReady for all enabled modules that have it
			for (const module of Module.modules.values()) {
				if (module.enabled) module.onReady?.();
			}

			// Hook module onTick into the physics pre-tick loop (gated by enabled)
			MinecraftClient.physics.onPreTick.push(() => {
				for (const module of Module.modules.values()) {
					if (module.enabled) module.onTickPre?.();
				}
			});

		};

		if (MinecraftClient.queue?.isQueued) {
			MinecraftClient.queue.once("leave-queue", () => MinecraftClient.bot.once("spawn", ready));
		} else if (MinecraftClient.bot.entity) {
			ready();
		} else {
			MinecraftClient.bot.once("spawn", ready);
		}
	}

	constructor(public readonly name: string) {
	}

	/** @internal — backing field for `enabled`, set by ConfigManager during load/reload. */
	public _enabled = true;

	/** Whether this module is active. Toggling persists to `config.yml` and fires `onEnable`/`onDisable`. */
	public get enabled(): boolean {
		return this._enabled;
	}
	public set enabled(value: boolean) {
		if (this._enabled === value) return;
		this._enabled = value;
		ConfigManager.setEnabled(this.name, value);
		if (value) {
			this.onEnable?.();
			if (MinecraftClient.bot.entity) this.onReady?.();
		} else {
			this.onDisable?.();
		}
	}

	/** Zod schema for module configuration. Override with a `z.object({...})` to expose config keys in `config.yml`. */
	public readonly zConfigSchema: TSchema = z.object({}) as unknown as TSchema;

	/** Parsed configuration for this module, populated from `config.yml` on load and on reload. */
	public config!: z.infer<TSchema>;

	/** Called for every packet received from the server. Override to handle packets. */
	public onPacketReceive?(packet: Packets.PacketEvent): unknown | Promise<unknown>;

	/** Called once the bot entity is ready (after queue if applicable). Override to initialize. */
	public onReady?(): void;

	/** Called every game tick (50ms) from the physics loop. */
	public onTickPre?(): void;

	/** Called after `this.config` is reassigned because `config.yml` changed on disk. */
	public onConfigReload?(): void;

	/** Called when this module transitions from disabled → enabled. */
	public onEnable?(): void;

	/** Called when this module transitions from enabled → disabled. */
	public onDisable?(): void;

}
