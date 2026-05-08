import { existsSync, readFileSync, watch, writeFileSync } from "fs";
import { Document, isMap, isPair, isScalar, parseDocument, YAMLMap } from "yaml";
import z from "zod";

const CONFIG_PATH = "config.yml";

type ReloadHandler = () => void;

export class ConfigManager {

	private static doc: Document = ConfigManager.loadDoc();

	private static dirty = false;

	private static reloadHandlers: ReloadHandler[] = [];

	private static watcherStarted = false;

	private static reloadDebounce: ReturnType<typeof setTimeout> | null = null;

	private static loadDoc(): Document {
		if (existsSync(CONFIG_PATH)) {
			try {
				return parseDocument(readFileSync(CONFIG_PATH, "utf8"));
			} catch (err) {
				console.error("Failed to parse config.yml; starting with empty document:", err);
			}
		}
		return new Document(new YAMLMap());
	}

	/** Get or create the top-level `modules` map. */
	private static getModulesRoot(): YAMLMap {
		let root = this.doc.get("modules");
		if (!isMap(root)) {
			root = new YAMLMap();
			this.doc.set("modules", root);
			this.dirty = true;
		}
		return root as YAMLMap;
	}

	/**
	 * Read a dot-separated path from the YAML document (e.g. `"general.chatcommands.prefix"`).
	 * Returns `undefined` when any segment is missing.
	 */
	public static get(path: string): unknown {
		const keys = path.split(".");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- walking arbitrary YAML
		let node: any = this.doc.toJS();
		for (const key of keys) {
			if (node === null || node === undefined || typeof node !== "object") return undefined;
			node = node[key];
		}
		return node;
	}

	/**
	 * Initialize a general (non-module) config section from a Zod schema.
	 * `path` is a dot-separated key like `"general.chatcommands"`.
	 * Missing keys are filled with schema defaults and comments; the validated
	 * config object is returned.
	 */
	public static initGeneral<T extends z.ZodTypeAny>(path: string, schema: T): z.infer<T> {
		const keys = path.split(".");

		// Walk / create nested YAML maps for each segment.
		let current: YAMLMap = this.doc.contents as YAMLMap;
		for (const key of keys) {
			let child = current.get(key);
			if (!isMap(child)) {
				child = new YAMLMap();
				current.set(key, child);
				this.dirty = true;
			}
			current = child as YAMLMap;
		}

		// Seed defaults + comments into the leaf map.
		this.applySchemaToMap(current, schema);
		if (this.dirty) this.write();

		// Resolve the JS value at the path and validate.
		let js: unknown = this.doc.toJS();
		for (const key of keys) {
			js = (js as Record<string, unknown>)?.[key];
		}
		return schema.parse(js ?? {}) as z.infer<T>;
	}

	/**
	 * Initialize a module's section in config.yml. Walks the schema, fills in any
	 * missing defaults, attaches `.describe()` text as YAML comments, and returns
	 * the parsed/validated config object plus the enabled flag.
	 *
	 * Layout per module:
	 * ```yaml
	 * ModuleName:
	 *   enabled: true
	 *   config:
	 *     key: value
	 * ```
	 */
	public static initModule<T extends z.ZodTypeAny>(name: string, schema: T): { enabled: boolean; config: z.infer<T> } {

		const modulesRoot = this.getModulesRoot();

		// Get/create the module section as a YAMLMap
		let section = modulesRoot.get(name);
		if (!isMap(section)) {
			section = new YAMLMap();
			modulesRoot.set(name, section);
			this.dirty = true;
		}
		const sectionMap = section as YAMLMap;

		// Ensure `enabled: true` exists with a comment
		if (!sectionMap.has("enabled")) {
			sectionMap.set("enabled", true);
			this.dirty = true;
		}
		this.applyComment(sectionMap, "enabled", "Whether this module is active");

		// Ensure `config` map exists when the schema has any keys
		const hasKeys = schema instanceof z.ZodObject && Object.keys(schema.shape).length > 0;
		if (hasKeys) {
			let configMap = sectionMap.get("config");
			if (!isMap(configMap)) {
				configMap = new YAMLMap();
				sectionMap.set("config", configMap);
				this.dirty = true;
			}
			this.applySchemaToMap(configMap as YAMLMap, schema);
		}

		if (this.dirty) this.write();

		// Build the JS object from the current YAML and validate
		const modulesJs = ((this.doc.toJS() ?? {}).modules ?? {}) as Record<string, { enabled?: unknown; config?: unknown }>;
		const sectionJs = modulesJs[name] ?? {};
		const enabled = typeof sectionJs.enabled === "boolean" ? sectionJs.enabled : true;
		const config = schema.parse(sectionJs.config ?? {}) as z.infer<T>;
		return { enabled, config };
	}

	/** Update the `enabled` flag for a module and persist immediately. */
	public static setEnabled(name: string, value: boolean) {
		const modulesRoot = this.doc.get("modules");
		if (!isMap(modulesRoot)) return;
		const section = (modulesRoot as YAMLMap).get(name);
		if (!isMap(section)) return;
		const sectionMap = section as YAMLMap;
		if (sectionMap.get("enabled") === value) return;
		sectionMap.set("enabled", value);
		this.suppressNextWatch = true;
		this.write();
	}

	/** Apply a `# description` comment before a key in a YAML map, replacing any existing comment(s). */
	private static applyComment(map: YAMLMap, key: string, description: string) {
		const idx = map.items.findIndex(p => isPair(p) && isScalar(p.key) && (p.key as { value: unknown }).value === key);
		if (idx < 0) return;
		const pair = map.items[idx];
		if (!pair || !isPair(pair)) return;
		const desired = ` ${ description }`;

		// yaml's parser stores the "comment before this pair" in different places depending
		// on the pair's position: for the FIRST pair in a map, the comment lives on the
		// parent map's `commentBefore`; for others it lives on `pair.key.commentBefore`.
		// Each pair owns exactly ONE slot — touching the wrong one corrupts a sibling.
		const isFirst = idx === 0;
		const target: { commentBefore?: string } = isFirst
			? (map as unknown as { commentBefore?: string })
			: (pair.key as { commentBefore?: string });

		if (target.commentBefore === desired) return;
		target.commentBefore = desired;
		this.dirty = true;
	}

	/** Recursively walk a Zod schema, writing defaults and comments to the YAML map. */
	private static applySchemaToMap(map: YAMLMap, schema: z.ZodTypeAny) {
		if (!(schema instanceof z.ZodObject)) return;

		for (const [ key, field ] of Object.entries(schema.shape) as Array<[ string, z.ZodTypeAny ]>) {

			const inner = this.unwrap(field);
			const description = field.description ?? inner.description;
			const defaultValue = this.getDefault(field);

			if (!map.has(key)) {

				// Insert the default
				if (inner instanceof z.ZodObject && (defaultValue === undefined || (typeof defaultValue === "object" && defaultValue !== null))) {
					const childMap = new YAMLMap();
					map.set(key, childMap);
					this.applySchemaToMap(childMap, inner);
				} else {
					map.set(key, defaultValue ?? null);
				}
				this.dirty = true;
			} else if (inner instanceof z.ZodObject) {

				// Recurse into existing nested map to fill in any missing nested keys
				const child = map.get(key);
				if (isMap(child)) this.applySchemaToMap(child as YAMLMap, inner);
			}

			// Apply description as a YAML comment on the key
			if (description) this.applyComment(map, key, description);
		}
	}

	/** Strip ZodDefault/ZodOptional/ZodNullable wrappers to get to the inner type. */
	private static unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
		let cur: z.ZodTypeAny = schema;
		while (true) {
			if (cur instanceof z.ZodDefault) cur = cur._def.innerType as z.ZodTypeAny;
			else if (cur instanceof z.ZodOptional) cur = cur._def.innerType as z.ZodTypeAny;
			else if (cur instanceof z.ZodNullable) cur = cur._def.innerType as z.ZodTypeAny;
			else break;
		}
		return cur;
	}

	/** Extract a default value from a schema, walking through ZodDefault wrappers. */
	private static getDefault(schema: z.ZodTypeAny): unknown {
		if (schema instanceof z.ZodDefault) {
			const def = schema._def.defaultValue;
			return typeof def === "function" ? (def as () => unknown)() : def;
		}
		if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
			return this.getDefault(schema._def.innerType as z.ZodTypeAny);
		}
		return undefined;
	}

	private static write() {

		// Mark a quiet window during which incoming fs.watch events are treated as our own.
		this.lastSelfWriteAt = Date.now();
		writeFileSync(CONFIG_PATH, this.doc.toString());
		this.dirty = false;
	}

	/** Register a callback to fire whenever config.yml changes on disk. */
	public static onReload(handler: ReloadHandler) {
		this.reloadHandlers.push(handler);
		this.startWatcher();
	}

	private static suppressNextWatch = false;

	private static lastSelfWriteAt = 0;

	/** Ignore fs.watch events that fire within this window after a self-write (ms). */
	private static readonly SELF_WRITE_QUIET_MS = 250;

	private static startWatcher() {
		if (this.watcherStarted) return;
		this.watcherStarted = true;

		watch(CONFIG_PATH, { persistent: false }, () => {
			if (this.suppressNextWatch) {
				this.suppressNextWatch = false;
				return;
			}
			if (Date.now() - this.lastSelfWriteAt < this.SELF_WRITE_QUIET_MS) return;
			if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
			this.reloadDebounce = setTimeout(() => {
				try {
					this.doc = this.loadDoc();
					for (const h of this.reloadHandlers) h();
				} catch (err) {
					console.error("Failed to reload config.yml:", err);
				}
			}, 100);
		});
	}

}
