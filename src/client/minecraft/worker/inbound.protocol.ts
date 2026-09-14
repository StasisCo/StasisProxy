/** Message contract between {@link ../manager/InboundWorker} and `inbound.worker.ts`. */

export interface WorkerOptions {

	/** Minecraft wire version the play-state deserializer is compiled for (e.g. `1.20.1`). */
	version: string;

	/** minecraft-protocol `customPackets` merged into the protocol, if any. */
	customPackets?: unknown;

	/** Whether frames carry the compression length prefix (set once compression is negotiated). */
	compressed: boolean;

	/** Mirrors the client's `hideErrors` — suppresses partial-read logging. */
	noErrorLogging: boolean;
}

export type MainToWorkerMessage =
	| { t: "chunk"; buf: ArrayBuffer }
	| { t: "compressed"; value: boolean }

	/** Take over AES-128-CFB8 decryption: every chunk after this one arrives encrypted. Both buffers are 16 bytes. */
	| { t: "cipher"; key: ArrayBuffer; shiftRegister: ArrayBuffer };

export interface ParsedItem {
	name: string;
	params: unknown;

	/** Offset and length of this packet's (decompressed) wire bytes inside the batch's `frames`. */
	off: number;
	len: number;

	/**
	 * Paths inside `params` whose value was a `Buffer` before the structured clone. Each
	 * such value travels as a {@link BufferRef} and is turned back into a `Buffer` on the
	 * main thread — structured clone would otherwise deliver a bare `Uint8Array`, which
	 * consumers (prismarine-chunk, plugin channels) call Buffer methods on.
	 */
	bufferPaths?: (string | number)[][];
}

/**
 * A `Buffer` field in transit: either a window into the batch's `frames` (the common case —
 * protodef returns views into the packet body) or, for a buffer that was not a view into
 * the body, its own copy of the bytes.
 */
export type BufferRef = { $off: number; $len: number } | { $bytes: Uint8Array };

export interface ErrorItem {
	error: { message: string; field?: string; partial: boolean };
	off: number;
	len: number;
}

export type BatchItem = ParsedItem | ErrorItem;

export interface BatchMessage {
	t: "batch";

	/** Every packet body of the batch, back to back; transferred, not copied. */
	frames: ArrayBuffer;
	items: BatchItem[];

	/** Cumulative parse time on the worker, ms. */
	parseMs: number;
}

export type WorkerToMainMessage = BatchMessage | { t: "ready" };
