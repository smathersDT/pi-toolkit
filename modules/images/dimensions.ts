/**
 * An image's dimensions, from its header, without decoding it.
 *
 * The useful resize target depends on the image's own shape (see policy.ts),
 * and the answer is in the first few dozen bytes of every format pi accepts.
 * An unrecognised or truncated header returns undefined, which the caller reads
 * as "fall back to the edge cap" — never as an error.
 */

export interface Dimensions {
	width: number;
	height: number;
}

function png(bytes: Uint8Array): Dimensions | undefined {
	// 8-byte signature, then a length+type IHDR chunk whose data starts at 16.
	if (bytes.length < 24) return undefined;
	if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gif(bytes: Uint8Array): Dimensions | undefined {
	// "GIF87a"/"GIF89a", then width and height as little-endian 16-bit.
	if (bytes.length < 10) return undefined;
	if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return undefined;
	return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

function webp(bytes: Uint8Array): Dimensions | undefined {
	// RIFF container, "WEBP", then one of three chunk layouts.
	if (bytes.length < 30) return undefined;
	const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
	const kind = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
	if (tag !== "RIFF" || kind !== "WEBP") return undefined;
	const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
	if (format === "VP8 ") {
		return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
	}
	if (format === "VP8L") {
		const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (format === "VP8X") {
		return {
			width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
			height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
		};
	}
	return undefined;
}

/**
 * JPEG has no fixed header offset: dimensions live in a start-of-frame marker
 * somewhere after an arbitrary run of metadata segments, so the segment chain
 * is walked. Bounded by the buffer; a malformed length ends it.
 */
function jpeg(bytes: Uint8Array): Dimensions | undefined {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1];
		// Spec-legal fill: any run of 0xFF may pad before a marker.
		if (marker === 0xff) {
			offset++;
			continue;
		}
		// Standalone markers carry no length field: stuffed 0x00, TEM, RST0-7, SOI.
		if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 2;
			continue;
		}
		// End of image: there is no frame header past it.
		if (marker === 0xd9) return undefined;
		// SOF0-SOF15, excluding the four that are not frame headers.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: (bytes[offset + 5] << 8) | bytes[offset + 6],
				width: (bytes[offset + 7] << 8) | bytes[offset + 8],
			};
		}
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		if (length < 2) return undefined;
		offset += 2 + length;
	}
	return undefined;
}

export function dimensions(bytes: Uint8Array): Dimensions | undefined {
	const found = png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
	if (!found || found.width <= 0 || found.height <= 0) return undefined;
	return found;
}
