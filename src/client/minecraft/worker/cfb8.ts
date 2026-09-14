import { createCipheriv } from "node:crypto";

/**
 * AES-128-CFB8 decryption, vectorised over native AES-ECB.
 *
 * Bun ships no `aes-128-cfb8` cipher, so minecraft-protocol falls back to aes-js — a pure
 * JavaScript AES that runs one block encryption per *byte* of traffic and costs about
 * 1.1 µs/byte (≈1.1 s of CPU per MiB). That was the largest per-byte cost on the main
 * thread at an entity-dense location, ahead of packet parsing.
 *
 * CFB8 decryption has no data dependency on its own output: the keystream byte for
 * position `i` is `AES_k(window_i)[0]` where `window_i` is the 16-byte window ending
 * just before byte `i` of `iv ‖ ciphertext`. Every window is known up front, so all of
 * them are laid out back to back and encrypted in a single native ECB call, and the
 * plaintext is the ciphertext XOR the first byte of each output block. Same result as
 * aes-js (checked in `cfb8.test.ts`), roughly 70× faster, at a 16× temporary buffer.
 */
export class Cfb8Decryptor {

	private readonly key: Buffer;

	/** The 16 most recent ciphertext bytes (initially the IV) — CFB's shift register. */
	private readonly shiftRegister: Buffer;

	constructor(key: Uint8Array, shiftRegister: Uint8Array) {
		if (key.length !== 16 || shiftRegister.length !== 16) throw new Error("AES-128-CFB8 needs a 16-byte key and shift register");
		this.key = Buffer.from(key);
		this.shiftRegister = Buffer.from(shiftRegister);
	}

	public decrypt(cipher: Buffer): Buffer {
		const n = cipher.length;
		if (n === 0) return cipher;

		// stream = shiftRegister ‖ cipher; window_i = stream[i, i + 16)
		const stream = Buffer.allocUnsafe(n + 16);
		this.shiftRegister.copy(stream, 0);
		cipher.copy(stream, 16);

		const blocks = Buffer.allocUnsafe(n * 16);
		for (let i = 0; i < n; i++) stream.copy(blocks, i * 16, i, i + 16);

		const ecb = createCipheriv("aes-128-ecb", this.key, null);
		ecb.setAutoPadding(false);
		const keystream = ecb.update(blocks);

		const plain = Buffer.allocUnsafe(n);
		for (let i = 0; i < n; i++) plain[i] = cipher[i]! ^ keystream[i * 16]!;

		// Carry the last 16 ciphertext bytes into the next call.
		stream.copy(this.shiftRegister, 0, n, n + 16);
		return plain;
	}

}
