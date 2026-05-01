import chalk from "chalk";
import { readFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, join } from "path";
import { Logger } from "~/class/Logger";

const require = createRequire(import.meta.url);
const PRISMARINE_VIEWER_PUBLIC = join(dirname(require.resolve("prismarine-viewer/package.json")), "public");

const logger = new Logger(chalk.hex("#7CFC00")("VIEWER"));

interface Patch {
	name: string;
	find: string | RegExp;
	replace: string;

	/** If true, missing patch only warns instead of erroring. Use for version-fragile patches. */
	optional?: boolean;
}

/**
 * String-replace patches applied to `prismarine-viewer/public/index.js` once,
 * at server startup, before the bundle is served to clients.
 *
 * Each patch targets a specific minified construct. They are inherently fragile
 * across upstream `prismarine-viewer` versions — if a patch fails to match,
 * we log a warning and serve the un-patched section. The override hooks in
 * `overrides.js` (browser-side) only fire for patches that actually applied.
 *
 * Currently empty: this is the framework only. Add patches here as we
 * implement features that can't be done from runtime overrides alone.
 *
 * Wishlist (in priority order):
 *  - Hook `Primitives.update` to call `window.__stasisAfterPrimitive(mesh, payload)`
 *    so the `alwaysVisible` field on primitives takes effect.
 *  - Replace hardcoded `0..256` world-height range with values from `bot.game`.
 *  - Add render paths for chests / shulker boxes (block-entity meshes).
 *  - Fix entity rendering precision at high world coordinates.
 */
const PATCHES: readonly Patch[] = [

	// After a primitive mesh is built and added to the scene, give the browser
	// override a chance to mutate it (e.g. enable through-walls rendering when
	// the primitive payload sets `alwaysVisible`).
	{
		name: "primitive-after-hook",
		find: /this\.primitives\[t\.id\]=([a-z]),this\.scene\.add\(\1\)/,
		replace: "this.primitives[t.id]=$1,this.scene.add($1),(window.__stasisAfterPrimitive&&window.__stasisAfterPrimitive($1,t))"
	},

	// Replace the hardcoded 0..256 section-dirty loops in addColumn/removeColumn
	// with the world bounds advertised by the server. Defaults preserve the
	// upstream 0..256 behaviour if the globals aren't set.
	{
		name: "world-height-section-loops",
		find: /for\(let i=0;i<256;i\+=16\)/g,
		replace: "for(let i=(window.__stasisMinY||-64);i<(window.__stasisMaxY||320);i+=16)"
	},

	// Render boxgrid primitives as a single outer box instead of a per-block
	// grid (the upstream impl passes the dimensions as the segment counts,
	// producing 1×1×1 subdivisions across the whole region).
	{
		name: "boxgrid-single-box",
		find: "BoxBufferGeometry(i,r,a,i,r,a)",
		replace: "BoxBufferGeometry(i,r,a,1,1,1)"
	},

	// Expose the bundle's THREE module namespace so overrides.js can build
	// fill meshes / use additional THREE classes from the browser side.
	{
		name: "expose-three",
		find: "if(\"boxgrid\"===t.type){const e=t.color?t.color:\"aqua\"",
		replace: "if(\"boxgrid\"===t.type){window.THREE=n;const e=t.color?t.color:\"aqua\""
	}
] as const;

let cached: { js: string; worker: string } | null = null;

/** Loads & patches the bundle once, then memoizes the result. */
export async function getPatchedClient(): Promise<{ js: string; worker: string }> {
	if (cached) return cached;

	const [ js, worker ] = await Promise.all([
		readFile(join(PRISMARINE_VIEWER_PUBLIC, "index.js"), "utf8"),
		readFile(join(PRISMARINE_VIEWER_PUBLIC, "worker.js"), "utf8")
	]);

	const patchedJs = applyPatches("index.js", js);

	cached = { js: patchedJs, worker };
	return cached;
}

function applyPatches(file: string, source: string): string {
	let out = source;
	let applied = 0;

	for (const patch of PATCHES) {
		const before = out;
		out = typeof patch.find === "string"
			? out.replace(patch.find, patch.replace)
			: out.replace(patch.find, patch.replace);

		if (out === before) {
			const msg = `${ file }: patch '${ patch.name }' did not match`;
			if (patch.optional) logger.warn(msg);
			else logger.error(msg);
		} else {
			applied++;
		}
	}

	if (PATCHES.length > 0) logger.log(`${ file }: applied ${ applied }/${ PATCHES.length } patches`);
	return out;
}
