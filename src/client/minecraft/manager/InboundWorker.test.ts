import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { deflateSync } from "node:zlib";
import mcData from "minecraft-data";
import { PROTOCOL_VERSION } from "../protocol";
import { InboundWorker } from "./InboundWorker";

/**
 * End-to-end handover test against a real minecraft-protocol client with a fake socket:
 * encryption on (so the aes-js fallback is in place), compression on, play state. Half of
 * the traffic is delivered before the worker attaches, a frame is deliberately cut in two
 * across the handover, and the rest is delivered afterwards. Every packet must arrive
 * exactly once, in order, with the right params and raw bytes.
 */
const require = createRequire(import.meta.url);
const { Client } = require("minecraft-protocol");
const { createSerializer } = require("minecraft-protocol/src/transforms/serializer");
const [ , writeVarInt, sizeOfVarInt ] = require("protodef").types.varint;
const aesjs = require("aes-js");

const VERSION = PROTOCOL_VERSION;
const THRESHOLD = 256;

/** Serialize + compress-frame one clientbound packet the way a server would. */
function wire(serializer: { proto: { createPacketBuffer(type: string, value: unknown): Buffer } }, name: string, params: unknown): { body: Buffer; framed: Buffer } {
	const body = serializer.proto.createPacketBuffer("packet", { name, params });
	let payload: Buffer;
	if (body.length >= THRESHOLD) {
		const z = deflateSync(body);
		payload = Buffer.alloc(sizeOfVarInt(body.length) + z.length);
		z.copy(payload, writeVarInt(body.length, payload, 0));
	} else {
		payload = Buffer.alloc(1 + body.length);
		payload[0] = 0;
		body.copy(payload, 1);
	}
	const framed = Buffer.alloc(sizeOfVarInt(payload.length) + payload.length);
	payload.copy(framed, writeVarInt(payload.length, framed, 0));
	return { body, framed };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("InboundWorker", () => {
	test("hands an encrypted, compressed play stream over to the worker without losing or reordering a packet", async() => {

		// A socket whose writes vanish and whose reads we drive by hand.
		const socket = new Duplex({ read() {}, write(_chunk, _enc, cb) {
			cb();
		} });
		(socket as unknown as { setNoDelay: () => void }).setNoDelay = () => {};

		const client = new Client(false, VERSION);
		client.setSocket(socket);
		const secret = randomBytes(16);
		client.setEncryption(secret);
		client.setCompressionThreshold(THRESHOLD);

		// Bun has no native CFB8: the fallback whose state the worker takes over must be in place.
		expect(typeof client.decipher.aes).toBe("object");

		const received: { name: string; params: unknown; buffer: Buffer }[] = [];
		client.on("packet", (params: unknown, meta: { name: string }, buffer: Buffer) => received.push({ name: meta.name, params, buffer }));
		client.on("error", (err: unknown) => {
			throw err;
		});

		const worker = new InboundWorker({ _client: client } as never);
		client.emit("connect");
		client.state = "play";

		// Build the expected stream: a mix of tiny entity packets and a >threshold one.
		const serializer = createSerializer({ state: "play", isServer: true, version: VERSION });
		const expected: { name: string; params: unknown; body: Buffer }[] = [];
		const frames: Buffer[] = [];
		for (let i = 0; i < 2000; i++) {

			// Buffer-typed fields ride along in both flavours: a small payload (a view into an
			// uncompressed body) and one past the compression threshold (a view into an inflated body).
			const packet = i % 100 === 50
				? { name: "chat_suggestions", params: { action: 0, entries: Array.from({ length: 40 }, (_, k) => `entry_${ i }_${ k }`) }}
				: i % 100 === 25
					? { name: "custom_payload", params: { channel: "minecraft:brand", data: Buffer.from(`vanilla${ i }`) }}
					: i % 100 === 75
						? { name: "custom_payload", params: { channel: "stasis:blob", data: Buffer.alloc(600, i & 0xff) }}
						: i % 3 === 0
							? { name: "entity_head_rotation", params: { entityId: 1000 + i, headYaw: i & 0x7f }}
							: { name: "rel_entity_move", params: { entityId: 1000 + i, dX: i, dY: -i, dZ: 7, onGround: (i & 1) === 1 }};
			const { body, framed } = wire(serializer, packet.name, packet.params);
			expected.push({ ...packet, body });
			frames.push(framed);
		}
		const all = Buffer.concat(frames);
		const encrypt = new aesjs.ModeOfOperation.cfb(secret, secret, 1);
		const enc = (bytes: Buffer) => Buffer.from(encrypt.encrypt(bytes));

		// Before attach: half the stream through the stock chain, ending mid-frame so the
		// splitter holds a remainder and the cipher shift register is mid-stream.
		const cut = Math.floor(all.length / 2) + 3;
		socket.push(enc(all.subarray(0, cut)));
		await sleep(50);
		const beforeAttach = received.length;
		expect(beforeAttach).toBeGreaterThan(0);
		expect(beforeAttach).toBeLessThan(expected.length);

		// Wait for the worker to compile the protocol and attach.
		for (let i = 0; i < 200 && !(worker as unknown as { attached: boolean }).attached; i++) await sleep(50);
		expect((worker as unknown as { attached: boolean; cipherMoved: boolean }).attached).toBe(true);
		expect((worker as unknown as { attached: boolean; cipherMoved: boolean }).cipherMoved).toBe(true);

		// After attach: the rest, in ragged pieces.
		for (let offset = cut, k = 0; offset < all.length; k++) {
			const len = Math.min(all.length - offset, [ 5, 1400, 33, 9000, 1 ][k % 5]!);
			socket.push(enc(all.subarray(offset, offset + len)));
			offset += len;
		}
		for (let i = 0; i < 100 && received.length < expected.length; i++) await sleep(50);

		expect(received.length).toBe(expected.length);
		let bufferFields = 0;
		for (let i = 0; i < expected.length; i++) {
			expect(received[i]!.name).toBe(expected[i]!.name);
			expect(received[i]!.params).toEqual(expected[i]!.params);
			expect(Buffer.from(received[i]!.buffer).equals(expected[i]!.body)).toBe(true);
			const data = (received[i]!.params as { data?: unknown }).data;
			if (data !== undefined) {

				// Must be a real Buffer again (consumers call readUInt8 & co.), not a bare Uint8Array.
				expect(Buffer.isBuffer(data)).toBe(true);
				bufferFields++;
			}
		}
		expect(bufferFields).toBe(40);
		expect(worker.stats()!.packets).toBe(expected.length - beforeAttach);

		worker.stop();
	}, 20_000);

	/**
	 * A server switch through the offloaded pipeline: play → start_configuration → configuration
	 * → finish_configuration → play, encrypted and compressed. The configuration packets are
	 * glued onto the same socket chunk as start_configuration (so the worker must hold them back,
	 * still decrypting, and hand them over), with a frame cut across that chunk boundary, and the
	 * second play phase must land back on the worker. Every packet must arrive once, in order, in
	 * the protocol state it was sent in, with its exact bytes.
	 */
	test("hands the stream back across a server switch and re-attaches afterwards", async() => {
		const socket = new Duplex({ read() {}, write(_chunk, _enc, cb) {
			cb();
		} });
		(socket as unknown as { setNoDelay: () => void }).setNoDelay = () => {};

		const client = new Client(false, VERSION);
		client.setSocket(socket);
		const secret = randomBytes(16);
		client.setEncryption(secret);
		client.setCompressionThreshold(THRESHOLD);

		// What minecraft-protocol's client/play.js does on these (the bare Client lacks it).
		client.on("start_configuration", () => {
			client.state = "configuration";
		});
		client.on("finish_configuration", () => {
			client.state = "play";
		});

		const received: { name: string; state: string; params: unknown; buffer: Buffer }[] = [];
		client.on("packet", (params: unknown, meta: { name: string; state: string }, buffer: Buffer) => received.push({ name: meta.name, state: meta.state, params, buffer: Buffer.from(buffer) }));
		client.on("error", (err: unknown) => {
			throw err;
		});

		const worker = new InboundWorker({ _client: client } as never);
		const internals = worker as unknown as { attached: boolean; cipherMoved: boolean; handingBack: boolean };
		client.emit("connect");
		client.state = "play";
		for (let i = 0; i < 200 && !internals.attached; i++) await sleep(50);
		expect(internals.attached).toBe(true);
		expect(internals.cipherMoved).toBe(true);

		const play = createSerializer({ state: "play", isServer: true, version: VERSION });
		const configuration = createSerializer({ state: "configuration", isServer: true, version: VERSION });
		const expected: { name: string; state: string; params: unknown; body: Buffer; compareParams: boolean }[] = [];
		const frame = (state: "play" | "configuration", name: string, params: unknown, compareParams = true): Buffer => {
			const { body, framed } = wire(state === "play" ? play : configuration, name, params);
			expected.push({ name, state, params, body, compareParams });
			return framed;
		};
		const entityBurst = (from: number, count: number) => Array.from({ length: count }, (_, k) => frame("play", "rel_entity_move", { entityId: from + k, dX: k, dY: 7 - k, dZ: 3, onGround: (k & 1) === 0 }));

		// Registry payloads big enough to be compressed, straight from the 1.20.6 login data.
		const codec = (mcData(VERSION) as unknown as { loginPacket: { dimensionCodec: Record<string, unknown> } }).loginPacket.dimensionCodec;
		const before = Buffer.concat([
			...entityBurst(1000, 300),
			frame("play", "start_configuration", {})
		]);
		const config = Buffer.concat([
			frame("configuration", "registry_data", codec["minecraft:dimension_type"], false),
			frame("configuration", "registry_data", codec["minecraft:worldgen/biome"], false),
			frame("configuration", "feature_flags", { features: [ "minecraft:vanilla" ]}),
			frame("configuration", "custom_payload", { channel: "minecraft:brand", data: Buffer.from("velocity") }),
			frame("configuration", "finish_configuration", {})
		]);
		const after = Buffer.concat(entityBurst(5000, 300));

		const encrypt = new aesjs.ModeOfOperation.cfb(secret, secret, 1);
		const enc = (bytes: Buffer) => Buffer.from(encrypt.encrypt(bytes));

		// One chunk: the first play phase, start_configuration, and the configuration phase up
		// to a frame cut in two; the rest of that frame in the next chunk.
		const cut = Math.floor(config.length / 2);
		socket.push(enc(Buffer.concat([ before, config.subarray(0, cut) ])));
		socket.push(enc(config.subarray(cut)));

		// The configuration phase ends in finish_configuration → play → the worker re-attaches.
		for (let i = 0; i < 200 && !(internals.attached && received.length === 300 + 1 + 5); i++) await sleep(25);
		expect(received.length).toBe(300 + 1 + 5);
		expect(internals.attached).toBe(true);
		expect(internals.cipherMoved).toBe(true);
		expect(client.state).toBe("play");

		// The second play phase, in ragged pieces, through the worker again.
		for (let offset = 0, k = 0; offset < after.length; k++) {
			const len = Math.min(after.length - offset, [ 7, 900, 2, 3000 ][k % 4]!);
			socket.push(enc(after.subarray(offset, offset + len)));
			offset += len;
		}
		for (let i = 0; i < 100 && received.length < expected.length; i++) await sleep(50);

		expect(received.length).toBe(expected.length);
		for (let i = 0; i < expected.length; i++) {
			expect(`${ received[i]!.state }.${ received[i]!.name }`).toBe(`${ expected[i]!.state }.${ expected[i]!.name }`);
			expect(received[i]!.buffer.equals(expected[i]!.body)).toBe(true);
			if (expected[i]!.compareParams) expect(received[i]!.params).toEqual(expected[i]!.params);
		}

		// The worker parsed both play phases — start_configuration included — and not one
		// configuration packet: those went through the stock pipeline.
		expect(worker.stats()!.packets).toBe(300 + 1 + 300);

		worker.stop();
	}, 30_000);
});
