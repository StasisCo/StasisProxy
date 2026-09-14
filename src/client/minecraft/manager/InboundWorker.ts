import chalk from "chalk";
import type { Client } from "minecraft-protocol";
import type { Bot } from "mineflayer";
import type { Duplex, Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import { Logger } from "~/class/Logger";
import type { BatchMessage, BufferRef, MainToWorkerMessage, WorkerOptions, WorkerToMainMessage } from "../worker/inbound.protocol";

/**
 * Offloads the clientbound packet pipeline to a worker thread.
 *
 * minecraft-protocol decodes every packet on the main thread through a chain of stream
 * transforms: socket → (decipher) → splitter → decompressor → deserializer → `packet`
 * events. Measured against a local 5000-entity spam server (`scripts/bench`), the chain
 * costs about 3.3 µs per packet on a desktop core, roughly 60% of it in split/inflate/
 * parse — work with no side effects on bot state, and therefore movable. A mega farm's
 * server flushes on the order of 10k entity packets per tick, so on a slower container
 * core that chain alone exceeds the 50 ms tick budget and the physics loop starves.
 *
 * Once the client reaches the `play` state and the worker has compiled the protocol,
 * this class detaches the splitter from its source (the decipher when encryption is
 * on, otherwise the socket) and forwards each raw chunk to `inbound.worker.ts`, which
 * splits, inflates and parses it with the same compiled protodef parser the client
 * would have used. Results come back in order, one batch per chunk, and are pushed into
 * the client's existing play-state deserializer stream — so minecraft-protocol's own
 * `data` handler (bundle handling, `packet` / per-name / `raw` fan-out) runs unchanged
 * and every downstream consumer sees exactly what it saw before, including the raw wire
 * buffer that {@link PacketCache} and the proxy bridge replay verbatim.
 *
 * What stays on the main thread is materialising the parsed objects out of the
 * structured-clone message, the emit fan-out and the listeners themselves. With the
 * bench server flushing once per tick like a real server, main-thread load at ~100k
 * packets/s roughly halves (33% → 15%, 25% → 13% across runs) — see `docs/grim-v2.md` §K.
 *
 * Failure policy: if the worker dies before it ever attaches, the stock pipeline simply
 * stays in place. If it dies while attached, the bytes it held are gone and the stream
 * cannot be resumed, so the connection is ended for the reconnect path to rebuild — and
 * the offload is disabled for the rest of the process so a broken worker cannot turn
 * into a reconnect loop. `MC_INBOUND_WORKER=0` disables it outright.
 */
export class InboundWorker {

	private static logger = new Logger(chalk.magenta("INBOUND"));

	/** The instance bound to the current bot, for stats reporting. */
	public static current?: InboundWorker;

	/** Set once a worker has failed; later bots keep the stock pipeline. */
	private static disabled = process.env.MC_INBOUND_WORKER === "0";

	private worker?: Worker;

	/** The worker has compiled the protocol and is accepting chunks. */
	private ready = false;

	private attached = false;

	private stopped = false;

	/** Stream we take `data` events from: the socket, or a native decipher's output. */
	private source?: Readable;

	/** Decryption was handed to the worker; the main-thread decipher is stale from then on. */
	private cipherMoved = false;

	private readonly onSourceData = (chunk: Buffer) => this.feed(chunk);

	/** Cumulative counters since attach, sampled by {@link stats}. */
	private counters = { packets: 0, bytes: 0, batches: 0, mainMs: 0, workerParseMs: 0 };

	private lastSample = { ...this.counters };

	constructor(private readonly bot: Bot) {
		if (InboundWorker.disabled) return;

		const client = this.client;

		// Spawn as soon as the socket connects: compiling the protocol in the worker takes
		// ~1 s, and the handshake, login and (on 2b2t) the queue all happen before any
		// traffic worth offloading.
		client.on("connect", () => this.spawn());

		client.on("state", (state: string) => {
			if (state === "play") {

				// The state flips from inside the splitter's own transform loop while the
				// rest of the socket chunk is still being consumed. Attach only once that
				// loop, and every nextTick-deferred stream emission behind it, has settled.
				setImmediate(() => this.attach());
			} else if (this.attached) {

				// 1.20.1 never leaves play until disconnect; anything else is unexpected.
				InboundWorker.logger.warn(`Client left play state (${ state }) while offloaded — restoring stock pipeline`);
				this.detach();
			}
		});

		client.on("end", () => this.stop());
		InboundWorker.current = this;
	}

	private get client(): Client & InternalClient {
		return this.bot._client as unknown as Client & InternalClient;
	}

	private spawn() {
		if (this.worker || this.stopped) return;
		const client = this.client;

		const workerData: WorkerOptions = {
			version: client.version,
			customPackets: client.customPackets,
			compressed: client.decompressor !== null && client.decompressor !== undefined,
			noErrorLogging: client.hideErrors === true
		};

		const worker = new Worker(new URL("../worker/inbound.worker.ts", import.meta.url), { workerData });
		this.worker = worker;

		worker.on("message", (message: WorkerToMainMessage) => {
			if (message.t === "batch") {
				this.onBatch(message);
			} else if (message.t === "ready") {
				InboundWorker.logger.log("Worker thread ready", chalk.dim(`(protocol ${ client.version })`));
				this.ready = true;
				this.attach();
			}
		});

		worker.on("error", err => this.fail("Worker thread crashed", err));

		worker.on("exit", code => {
			this.worker = undefined;
			if (!this.stopped && code !== 0) this.fail(`Worker thread exited with code ${ code }`);
		});

		// Don't keep the process alive on the worker's account.
		worker.unref();
	}

	/**
	 * Attach once both preconditions hold: the client is in `play`, and the worker is
	 * ready. Either event may come last. Called outside any socket read callback, so the
	 * old pipeline has fully drained and the splitter holds only a partial frame.
	 */
	private attach() {
		if (this.attached || this.stopped || !this.ready || !this.worker) return;
		const client = this.client;
		if (client.state !== "play") return;

		const splitter = client.splitter;
		const decipher = client.decipher ?? null;

		// Where to take the bytes from. With encryption on, minecraft-protocol under Bun uses
		// its aes-js fallback (Bun has no native CFB8) — a pure-JS cipher costing ~1.1 µs per
		// byte on the main thread, more than parsing. Its state is two 16-byte arrays, so the
		// worker can take decryption over as well: read straight from the socket and hand the
		// worker the key and the current shift register. A native decipher (Node) keeps its
		// state opaque; there we read its decrypted output instead and only move parsing.
		const cipherState = decipher ? InboundWorker.extractCipherState(decipher) : null;
		const source: Readable = decipher && !cipherState ? decipher : client.socket;
		const upstreamDest: Duplex = decipher && cipherState ? (decipher as unknown as Duplex) : splitter;

		// Compression is negotiated during login, before play; tell the worker its final state.
		this.post({ t: "compressed", value: client.decompressor !== null && client.decompressor !== undefined });

		// Detach the stock chain at the source, then adopt the splitter's partial-frame
		// remainder as the first chunk so no byte is lost across the handover. It is already
		// decrypted, so it goes ahead of the cipher handover. `unpipe` pauses a source with no
		// pipes left, hence the explicit resume after taking its data events over.
		source.unpipe(upstreamDest);
		if (cipherState) decipher!.unpipe(splitter);
		const remainder = splitter.buffer;
		splitter.buffer = Buffer.alloc(0);
		this.source = source;
		this.attached = true;
		if (remainder.length > 0) this.feed(remainder);
		if (cipherState) {
			this.cipherMoved = true;
			this.post({ t: "cipher", key: cipherState.key, shiftRegister: cipherState.shiftRegister }, [ cipherState.key, cipherState.shiftRegister ]);
		}
		source.on("data", this.onSourceData);
		source.resume();

		const mode = decipher ? (cipherState ? "encrypted, decrypting in worker" : "encrypted, native decipher on main") : "plain";
		InboundWorker.logger.log("Inbound packet pipeline offloaded to worker thread", chalk.dim(`(${ mode }, ${ client.decompressor ? "compressed" : "uncompressed" })`));
	}

	/**
	 * Copy the key and shift register out of minecraft-protocol's aes-js `Decipher` fallback
	 * (`transforms/encryption.js`). Returns null for a native decipher, whose state is not
	 * observable, or if the transform still holds unprocessed bytes — the handover would
	 * split a stream mid-byte-sequence, so it is safer to leave decryption where it is.
	 */
	private static extractCipherState(decipher: Readable): { key: ArrayBuffer; shiftRegister: ArrayBuffer } | null {
		const aes = (decipher as unknown as { aes?: { _aes?: { key?: Uint8Array }; _shiftRegister?: Uint8Array } }).aes;
		const key = aes?._aes?.key;
		const shiftRegister = aes?._shiftRegister;
		if (!key || !shiftRegister || key.length !== 16 || shiftRegister.length !== 16) return null;

		const state = decipher as unknown as { writableLength?: number; readableLength?: number };
		if ((state.writableLength ?? 0) !== 0 || (state.readableLength ?? 0) !== 0) {
			InboundWorker.logger.warn("Decipher holds buffered bytes at attach — keeping decryption on the main thread");
			return null;
		}

		return { key: Uint8Array.from(key).buffer, shiftRegister: Uint8Array.from(shiftRegister).buffer };
	}

	/**
	 * Hand the stock pipeline back. Bytes still in the worker's buffer are lost — only used
	 * on unexpected state changes, where the connection is moribund anyway. Once decryption
	 * has moved there is nothing to hand back to (the main-thread cipher state is stale), so
	 * the connection is ended instead.
	 */
	private detach() {
		if (!this.attached) return;
		this.attached = false;
		const source = this.source!;
		source.off("data", this.onSourceData);
		this.source = undefined;
		if (this.cipherMoved) {
			this.client.end("inbound worker detached after cipher handover");
			return;
		}
		source.pipe(this.client.splitter);
	}

	/**
	 * Worker failure. Before attach nothing was taken from the stock pipeline, so the bot
	 * carries on unaffected; after attach the connection has to be rebuilt. Either way the
	 * offload stays off for the rest of the process.
	 */
	private fail(message: string, err?: unknown) {
		if (this.stopped) return;
		InboundWorker.disabled = true;
		const wasAttached = this.attached;
		InboundWorker.logger.error(`${ message } — inbound offload disabled${ wasAttached ? ", ending connection" : "" }`, err ?? "");
		this.stop();
		if (wasAttached) this.client.end("inbound worker crashed");
	}

	/**
	 * Ship one socket chunk. A copy is unavoidable: socket chunks are views into a shared
	 * pool and cannot be transferred individually. Chunks arrive at the server's flush
	 * cadence (one per tick on a busy link, split by the OS into reads of up to 64 KiB),
	 * so the per-message cost is negligible next to the parsing it carries away.
	 */
	private feed(chunk: Buffer) {
		const copy = new Uint8Array(chunk.length);
		copy.set(chunk);
		this.counters.bytes += chunk.length;
		this.post({ t: "chunk", buf: copy.buffer }, [ copy.buffer ]);
	}

	private post(message: MainToWorkerMessage, transfer?: ArrayBuffer[]) {
		this.worker?.postMessage(message, transfer);
	}

	private onBatch(message: BatchMessage) {
		if (!this.attached) return;
		const started = performance.now();
		const client = this.client;
		const deserializer = client.deserializer;
		const frames = Buffer.from(message.frames);

		for (const item of message.items) {
			const buffer = frames.subarray(item.off, item.off + item.len);
			if ("error" in item) {

				// Mirror FullPacketParser: partial reads are skipped (logged unless hidden),
				// anything else surfaces through the deserializer's error path so the
				// client's own handler formats and re-emits it.
				if (item.error.partial) {
					if (!client.hideErrors) InboundWorker.logger.warn(`Partial packet skipped: ${ item.error.message }`);
					continue;
				}
				const err = new Error(item.error.message) as Error & { field?: string; buffer?: Buffer };
				err.field = item.error.field;
				err.buffer = buffer;
				deserializer.emit("error", err);
				continue;
			}
			if (item.bufferPaths) InboundWorker.restoreBuffers(item.params, item.bufferPaths, frames);
			deserializer.push({ data: { name: item.name, params: item.params }, metadata: { size: item.len }, buffer, fullBuffer: buffer });
		}

		this.counters.packets += message.items.length;
		this.counters.batches++;
		this.counters.workerParseMs = message.parseMs;
		this.counters.mainMs += performance.now() - started;
	}

	/**
	 * Put `Buffer`s back where the worker took them out: windows into the batch buffer are
	 * wrapped without copying, standalone copies are wrapped in place.
	 */
	private static restoreBuffers(params: unknown, paths: (string | number)[][], frames: Buffer) {
		for (const path of paths) {
			let parent = params as Record<string | number, unknown>;
			for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]!] as Record<string | number, unknown>;
			const key = path[path.length - 1]!;
			const ref = parent[key] as BufferRef;
			parent[key] = "$bytes" in ref
				? Buffer.from(ref.$bytes.buffer, ref.$bytes.byteOffset, ref.$bytes.byteLength)
				: frames.subarray(ref.$off, ref.$off + ref.$len);
		}
	}

	/**
	 * Counters since the last call, for the tick watchdog's degraded report. `mainMs` is
	 * time spent delivering batches on the main thread (emit fan-out and listeners
	 * included); `workerMs` is parse time that left the main thread.
	 */
	public stats(): { packets: number; bytes: number; batches: number; mainMs: number; workerMs: number } | null {
		if (!this.attached) return null;
		const now = this.counters;
		const last = this.lastSample;
		const out = {
			packets: now.packets - last.packets,
			bytes: now.bytes - last.bytes,
			batches: now.batches - last.batches,
			mainMs: now.mainMs - last.mainMs,
			workerMs: now.workerParseMs - last.workerParseMs
		};
		this.lastSample = { ...now };
		return out;
	}

	public stop() {
		if (this.stopped) return;
		this.stopped = true;
		if (this.attached) {
			this.attached = false;
			this.source?.off("data", this.onSourceData);
			this.source = undefined;
		}
		void this.worker?.terminate();
		this.worker = undefined;
		if (InboundWorker.current === this) InboundWorker.current = undefined;
	}

}

/** minecraft-protocol client internals the typings leave out. */
interface InternalClient {
	state: string;
	version: string;
	customPackets?: unknown;
	hideErrors?: boolean;
	socket: Readable;
	decipher?: Readable | null;
	decompressor?: object | null;
	splitter: Duplex & { buffer: Buffer };
	deserializer: Duplex;
	end(reason?: string): void;
}
