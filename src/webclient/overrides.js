/* eslint-disable */
/**
 * Runtime overrides for the prismarine-viewer web client.
 *
 * This script runs in the browser AFTER the patched bundle has executed, so
 * the THREE namespace (and any globals our bundle patches expose) already
 * exist. Use this file for monkey-patches that don't require touching the
 * minified internals — anything deeper is handled by `patches.ts` (server
 * side) before the bundle is sent to the browser.
 */
(function () {
	"use strict";

	// Tag the page so we can verify in devtools that overrides actually loaded.
	console.log("%c[stasis-viewer] overrides.js loaded", "color:#7CFC00;font-weight:bold");

	// ── alwaysVisible primitives ──────────────────────────────────────────────
	// The bundle creates LineBasicMaterial / MeshLineMaterial for primitives.
	// We expose a tiny hook the server-patched bundle calls right after each
	// primitive mesh is built; if the primitive payload sets `alwaysVisible`,
	// we disable depth testing and bump the render order so it draws over the
	// world geometry.
	window.__stasisAfterPrimitive = function (mesh, primitive) {
		if (!mesh || !primitive) return;

		// Boxgrid: thicken the outline and add a translucent fill mesh so the
		// region is visible from a distance.
		if (primitive.type === "boxgrid" && window.THREE) {
			const T = window.THREE;
			const sx = primitive.end.x - primitive.start.x;
			const sy = primitive.end.y - primitive.start.y;
			const sz = primitive.end.z - primitive.start.z;
			const color = primitive.color || "aqua";
			const fill = new T.Mesh(
				new T.BoxBufferGeometry(sx, sy, sz),
				new T.MeshBasicMaterial({
					color: color,
					transparent: true,
					opacity: 60 / 255,
					depthWrite: false,
					side: T.DoubleSide
				})
			);
			mesh.add(fill);
			if (mesh.material) mesh.material.linewidth = 3;
		}

		if (!primitive.alwaysVisible) return;
		mesh.renderOrder = 999;
		mesh.traverse(function (obj) {
			if (obj.material) {
				obj.material.depthTest = false;
				obj.material.depthWrite = false;
				obj.material.transparent = true;
			}
		});
	};

})();
