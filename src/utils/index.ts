/**
 * Recursively unwraps NBT-like structures into plain JS objects/arrays/primitives.
 * @param nbt - The NBT-like structure to unwrap
 * @returns The unwrapped plain JS object/array/primitive
 */
export function unwrapNbtLike(nbt: unknown): unknown {

	if (nbt === null || typeof nbt !== "object") return nbt;

	if ("type" in nbt && "value" in nbt) {
		if (nbt.type === "compound" && nbt.value && typeof nbt.value === "object") {
			const out: Record<string, unknown> = {};
			const valueObj = nbt.value as Record<string, unknown>;
			for (const k of Object.keys(valueObj)) out[k] = unwrapNbtLike(valueObj[k]);
			return out;
		}
		return unwrapNbtLike(nbt.value);
	}

	if (Array.isArray(nbt)) return nbt.map(unwrapNbtLike);
	
	const out: Record<string, unknown> = {};

	for (const k of Object.keys(nbt)) out[k] = unwrapNbtLike((nbt as Record<string, unknown>)[k]);

	return out;
}