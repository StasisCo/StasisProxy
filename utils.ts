import prismarineChat from "prismarine-chat";

// Generic method interceptor (no outer _write ref)
export function proxyMethod<T extends object, K extends keyof T & string>(
	obj: T,
	method: K,
	applyWrapper: (thisArg: T, args: unknown[], callOriginal: () => unknown) => unknown
): void {
	(obj as never)[method] = new Proxy((obj as never)[method], {
		apply(target, thisArg, args) {
			const callOriginal = () => Reflect.apply(target, thisArg, args);
			return applyWrapper(thisArg as T, args, callOriginal);
		}
	});
}

// Restorable proxy for a method; returns a restore() function.
export function proxyMethodRestorable<T extends object, K extends keyof T & string>(
	obj: T,
	method: K,
	applyWrapper: (thisArg: T, args: unknown[], callOriginal: () => unknown) => unknown
): () => void {
	const sym = Symbol(`__orig_${ String(method) }`)
  ;(obj as never)[sym] = (obj as never)[method]
	;(obj as never)[method] = new Proxy((obj as never)[method], {
		apply(target, thisArg, args) {
			const callOriginal = () => Reflect.apply(target as never, thisArg, args as never);
			return applyWrapper(thisArg as T, args as never, callOriginal);
		}
	});
	return () => {
		(obj as never)[method] = (obj as never)[sym];
		delete (obj as never)[sym];
	};
}

export function unwrapNbtLike(x: any): any {
	if (x == null || typeof x !== "object") return x;
	if ("type" in x && "value" in x) {
		if (x.type === "compound" && x.value && typeof x.value === "object") {
			const out: any = {};
			for (const k of Object.keys(x.value)) out[k] = unwrapNbtLike(x.value[k]);
			return out;
		}
		return unwrapNbtLike(x.value); // for primitives / lists
	}
	if (Array.isArray(x)) return x.map(unwrapNbtLike);
	const out: any = {};
	for (const k of Object.keys(x)) out[k] = unwrapNbtLike(x[k]);
	return out;
}

// 2) print as ANSI
export function printAnsiChat(reason: any, mcVersion = "1.21.4") {
	const ChatMessage = prismarineChat(mcVersion);
	const component = unwrapNbtLike(reason); // -> { text: '...', color: 'red', ... }
	try {
		const msg = new ChatMessage(
			typeof component === "string" ? { text: component } : component
		);
		return msg.toAnsi ? msg.toAnsi() : msg.toString();
	} catch {

		// Fallback if anything’s weird
		const text = typeof component === "object" ? component.text ?? JSON.stringify(component) : String(component);
		return text;
	}
}