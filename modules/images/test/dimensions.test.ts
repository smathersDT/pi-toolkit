import assert from "node:assert/strict";
import { test } from "node:test";
import { dimensions } from "../dimensions.ts";

/** A PNG header with an IHDR chunk, which is all the parser reads. */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

/** SOI, one APP0 segment to be skipped, then an SOF0 frame header. */
function jpegHeader(width: number, height: number): Uint8Array {
	const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
	const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff];
	return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0, 0, 0, 0]);
}

function webpHeader(format: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
	bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
	bytes.set([...format].map((c) => c.charCodeAt(0)), 12);
	if (format === "VP8 ") {
		bytes[26] = width & 0xff;
		bytes[27] = (width >> 8) & 0x3f;
		bytes[28] = height & 0xff;
		bytes[29] = (height >> 8) & 0x3f;
	} else if (format === "VP8L") {
		const bits = (width - 1) | ((height - 1) << 14);
		bytes[21] = bits & 0xff;
		bytes[22] = (bits >> 8) & 0xff;
		bytes[23] = (bits >> 16) & 0xff;
		bytes[24] = (bits >> 24) & 0xff;
	} else {
		const w = width - 1;
		const h = height - 1;
		bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
	}
	return bytes;
}

test("png", () => {
	assert.deepEqual(dimensions(pngHeader(2560, 1440)), { width: 2560, height: 1440 });
	assert.deepEqual(dimensions(pngHeader(1, 1)), { width: 1, height: 1 });
	assert.equal(dimensions(pngHeader(2560, 1440).slice(0, 20)), undefined, "cut off before IHDR is not guessed at");
	assert.equal(dimensions(pngHeader(0, 0)), undefined, "zero pixels is refused");
});

test("jpeg walks the segment chain and refuses to guess", () => {
	assert.deepEqual(dimensions(jpegHeader(1920, 1080)), { width: 1920, height: 1080 });
	assert.equal(dimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), undefined, "no frame header");
	assert.equal(dimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), undefined, "a malformed segment length ends the walk");
	const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80]; // 1920x1080
	assert.deepEqual(dimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xff, ...sof0, 0, 0, 0, 0])), { width: 1920, height: 1080 }, "fill bytes before a marker are skipped");
	assert.equal(dimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9, ...sof0, 0, 0, 0, 0])), undefined, "nothing is read past end-of-image");
});

test("gif, little-endian", () => {
	assert.deepEqual(dimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])), { width: 320, height: 240 });
});

test("webp in its three chunk layouts", () => {
	assert.deepEqual(dimensions(webpHeader("VP8 ", 640, 480)), { width: 640, height: 480 });
	assert.deepEqual(dimensions(webpHeader("VP8L", 1024, 768)), { width: 1024, height: 768 });
	assert.deepEqual(dimensions(webpHeader("VP8X", 2560, 1440)), { width: 2560, height: 1440 });
});

test("refusals", () => {
	assert.equal(dimensions(new Uint8Array(0)), undefined);
	assert.equal(dimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined);
});
