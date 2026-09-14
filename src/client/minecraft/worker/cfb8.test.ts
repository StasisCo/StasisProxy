import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Cfb8Decryptor } from "./cfb8";

// aes-js is minecraft-protocol's own CFB8 fallback — the reference we must match bit for bit.
const require = createRequire(import.meta.url);
const aesjs = require("aes-js");

describe("Cfb8Decryptor", () => {
	test("matches aes-js across arbitrary chunk boundaries", () => {
		const key = randomBytes(16);
		const plain = randomBytes(200_000);
		const cipher = Buffer.from(new aesjs.ModeOfOperation.cfb(key, key, 1).encrypt(plain));

		const dec = new Cfb8Decryptor(key, key);
		const parts: Buffer[] = [];
		const sizes = [ 1, 7, 15, 16, 17, 1400, 65_536, 3 ];
		for (let offset = 0, k = 0; offset < cipher.length; k++) {
			const len = Math.min(cipher.length - offset, sizes[k % sizes.length]!);
			parts.push(dec.decrypt(cipher.subarray(offset, offset + len)));
			offset += len;
		}
		expect(Buffer.concat(parts).equals(plain)).toBe(true);
	});

	test("resumes from a shift register taken mid-stream", () => {
		const key = randomBytes(16);
		const plain = randomBytes(5_000);
		const cipher = Buffer.from(new aesjs.ModeOfOperation.cfb(key, key, 1).encrypt(plain));

		// Decrypt the first half with aes-js (as the live client would have), then hand its
		// shift register to the vectorised decryptor for the rest — the attach handover.
		const reference = new aesjs.ModeOfOperation.cfb(key, key, 1);
		const head = Buffer.from(reference.decrypt(cipher.subarray(0, 2_345)));
		const dec = new Cfb8Decryptor(reference._aes.key, reference._shiftRegister);
		const tail = dec.decrypt(cipher.subarray(2_345));
		expect(Buffer.concat([ head, tail ]).equals(plain)).toBe(true);
	});

	test("empty input is a no-op", () => {
		const key = randomBytes(16);
		const dec = new Cfb8Decryptor(key, key);
		expect(dec.decrypt(Buffer.alloc(0)).length).toBe(0);
	});
});
