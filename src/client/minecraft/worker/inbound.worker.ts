/**
 * Inbound packet worker — see {@link ../manager/InboundWorker} for the design.
 *
 * Runs the CPU-bound stages of minecraft-protocol's clientbound pipeline � AES-CFB8
 * decryption (once the main thread hands its cipher state over), frame splitting, zlib
 * inflate and protodef parsing � off the main thread. The main thread ships it raw
 * socket chunks; it ships back one batch per chunk: every decoded packet's name and
 * params plus the packet's (decrypted, inflated) wire bytes.
 *
 * Kept dependency-free apart from minecraft-protocol so the worker starts fast and
 * cannot drag project state across threads.
 */
import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { inflateSync } from "node:zlib";
import { Cfb8Decryptor } from "./cfb8";
import type { BatchItem, BatchMessage, BufferRef, MainToWorkerMessage, WorkerOptions } from "./inbound.protocol";

if (isMainThread || !parentPort) throw new Error("inbound.worker must be started as a worker thread");

// minecraft-protocol's serializer module is CommonJS and not on its public surface.
const require = createRequire(import.meta.url);
const { createDeserializer } = require("minecraft-protocol/src/transforms/serializer") as {
	createDeserializer: (opts: { state: string; isServer: boolean; version: string; customPackets?: unknown; noErrorLogging?: boolean }) => {
		parsePacketBuffer: (buffer: Buffer) => { data: { name: string; params: unknown }; metadata: { size: number } };
	};
};

const options = workerData as WorkerOptions;

// Compiling the play-state protocol takes the better part of a second; do it before
// touching any message so the first batch is parsed by a warm parser.
const deserializer = createDeserializer({
	state: "play",
	isServer: false,
	version: options.version,
	customPackets: options.customPackets,
	noErrorLogging: options.noErrorLogging
});

let compressed = options.compressed;

/** Set once the main thread hands over the connection's cipher state; chunks arrive encrypted from then on. */
let decryptor: Cfb8Decryptor | null = null;

/** Bytes received but not yet forming a whole frame. */
let pending: Buffer = Buffer.alloc(0);

/** Cumulative parse time in ms, reported with every batch for the main thread's stats. */
let parseMs = 0;

/** Non-throwing varint read. Returns -1 as size when the buffer ends mid-varint. */
function readVarInt(buffer: Buffer, offset: number): { value: number; size: number } {
	let value = 0;
	let shift = 0;
	let cursor = offset;
	while (cursor < buffer.length) {
		const byte = buffer[cursor++]!;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value, size: cursor - offset };
		shift += 7;
		if (shift > 35) throw new Error("varint is too big");
	}
	return { value: 0, size: -1 };
}

/**
 * Replace every `Buffer` inside a parsed packet with a {@link BufferRef} and record where it
 * was. Views into the packet body become windows into the batch buffer (no bytes copied);
 * anything else is copied out. Walks the object graph protodef produced, which for the
 * hot entity packets is a handful of scalar fields.
 */
function detachBuffers(value: unknown, body: Buffer, bodyOffset: number, path: (string | number)[], paths: (string | number)[][]): unknown {
	if (value instanceof Uint8Array) {
		paths.push(path.slice());
		const inBody = value.buffer === body.buffer && value.byteOffset >= body.byteOffset && value.byteOffset + value.byteLength <= body.byteOffset + body.byteLength;
		const ref: BufferRef = inBody
			? { $off: bodyOffset + (value.byteOffset - body.byteOffset), $len: value.byteLength }
			: { $bytes: new Uint8Array(value) };
		return ref;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const entry = value[i];
			if (entry !== null && typeof entry === "object") {
				path.push(i);
				value[i] = detachBuffers(entry, body, bodyOffset, path, paths);
				path.pop();
			}
		}
		return value;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key in record) {
			const entry = record[key];
			if (entry !== null && typeof entry === "object") {
				path.push(key);
				record[key] = detachBuffers(entry, body, bodyOffset, path, paths);
				path.pop();
			}
		}
	}
	return value;
}

/**
 * Split every complete frame out of `pending`, inflate it if compression is on, parse
 * it, and post the whole lot back as one batch. Frame bodies are packed into one
 * contiguous buffer that is transferred (not copied) to the main thread.
 */
function processPending() {
	const bodies: Buffer[] = [];
	const items: BatchItem[] = [];
	let total = 0;
	let offset = 0;

	while (offset < pending.length) {
		const header = readVarInt(pending, offset);
		if (header.size < 0) break;
		const start = offset + header.size;
		const end = start + header.value;
		if (end > pending.length) break;
		offset = end;

		let body: Buffer = pending.subarray(start, end);
		if (compressed) {
			const dataLength = readVarInt(body, 0);
			if (dataLength.size < 0) continue;
			const payload = body.subarray(dataLength.size);
			if (dataLength.value === 0) {
				body = payload;
			} else {
				try {
					body = inflateSync(payload);
				} catch (err) {
					if (!options.noErrorLogging) console.error("inbound worker: problem inflating chunk", err);
					continue;
				}
			}
		}

		const started = performance.now();
		try {
			const packet = deserializer.parsePacketBuffer(body);
			if (packet.metadata.size !== body.length && !options.noErrorLogging) {
				console.log(`Chunk size is ${ body.length } but only ${ packet.metadata.size } was read ; partial packet : ${ JSON.stringify(packet.data) }; buffer :${ body.toString("hex") }`);
			}
			const paths: (string | number)[][] = [];
			const params = detachBuffers(packet.data.params, body, total, [], paths);
			items.push(paths.length ? { name: packet.data.name, params, off: total, len: body.length, bufferPaths: paths } : { name: packet.data.name, params, off: total, len: body.length });
		} catch (err) {
			const e = err as Error & { field?: string; partialReadError?: boolean };
			items.push({ error: { message: e.message, field: e.field, partial: e.partialReadError === true }, off: total, len: body.length });
		}
		parseMs += performance.now() - started;

		bodies.push(body);
		total += body.length;
	}

	pending = offset === 0 ? pending : Buffer.from(pending.subarray(offset));
	if (items.length === 0) return;

	const frames = new Uint8Array(total);
	let cursor = 0;
	for (const body of bodies) {
		frames.set(body, cursor);
		cursor += body.length;
	}

	const message: BatchMessage = { t: "batch", frames: frames.buffer, items, parseMs };
	parentPort!.postMessage(message, [ frames.buffer ]);
}

parentPort.on("message", (message: MainToWorkerMessage) => {
	switch (message.t) {
		case "chunk": {
			let chunk: Buffer = Buffer.from(message.buf);
			if (decryptor) chunk = decryptor.decrypt(chunk);
			pending = pending.length === 0 ? chunk : Buffer.concat([ pending, chunk ]);
			processPending();
			break;
		}
		case "compressed":
			compressed = message.value;
			break;
		case "cipher":
			decryptor = new Cfb8Decryptor(new Uint8Array(message.key), new Uint8Array(message.shiftRegister));
			break;
	}
});

parentPort.postMessage({ t: "ready" });
