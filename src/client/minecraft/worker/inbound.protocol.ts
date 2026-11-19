/** Message contract between {@link ../manager/InboundWorker} and `inbound.worker.ts`. */

export interface WorkerOptions {

	/** Minecraft wire version the play-state deserializer is compiled for (e.g. `1.20.6`). */
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
	| { t: "cipher"; key: ArrayBuffer; shiftRegister: ArrayBuffer }

	/**
	 * Give the stream back after a {@link BatchMessage.halted} batch. Sent once the main thread
	 * has stopped feeding chunks, so every chunk it posted is already queued ahead of this.
	 * Answered with a {@link ReleasedMessage}; the worker is then idle until the next attach.
	 */
	| { t: "release" };

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

	/**
	 * The batch ends with a packet that takes the connection out of the play state
	 * (`start_configuration`). Bytes after it belong to another protocol state, which the
	 * play-only parser cannot read: the worker holds them, unparsed, until `release`.
	 */
	halted?: boolean;
}

/** Reply to `release`: everything the worker held back, and where the cipher stream stands. */
export interface ReleasedMessage {
	t: "released";

	/** Received but unparsed bytes — already decrypted — starting at a frame boundary. */
	remainder: ArrayBuffer;

	/** The CFB8 shift register after the last decrypted byte, if decryption had been handed over. */
	shiftRegister: ArrayBuffer | null;
}

export type WorkerToMainMessage = BatchMessage | ReleasedMessage | { t: "ready" };
