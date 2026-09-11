/**
 * What an image costs, and what size it should be sent at. Pi-free so the
 * arithmetic can be tested under bare node — and because the arithmetic is the
 * part that is easy to get wrong.
 *
 * An image is not billed by its bytes but by its pixels *after the provider
 * has resized it*, and Anthropic applies two limits, not one:
 *
 *   - long edge at most 1568px
 *   - at most ~1.15 megapixels
 *
 * The second is the binding one. A 2000x2000 screenshot capped to 1568x1568
 * has lost 39% of its bytes and exactly zero tokens, because the provider
 * takes it to 1072x1072 anyway. Capping at 1072x1072 locally costs the same
 * zero tokens and saves 71% of the bytes. So the default is not a number: it is
 * "send what the provider was going to use".
 */

/** Long-edge limit, in pixels. */
export const PROVIDER_EDGE = 1568;

/** Total-pixel limit. The binding constraint for anything close to square. */
export const PROVIDER_PIXELS = 1_150_000;

/** Pixels per image token. */
const PIXELS_PER_TOKEN = 750;

/** Base64 length below which an image is left alone (48KB ≈ a 36KB file). */
export const FLOOR_BYTES = 48 * 1024;

/** A resize that saves less than this fraction is not worth the re-encode. */
const WORTH_IT = 0.1;

/**
 * Whether the provider-fit numbers apply to the model in front of us. They are
 * Anthropic's, whichever gateway serves the model; on any other family only an
 * explicit user cap may resize, and the token arithmetic claims zero.
 */
export function providerFitApplies(model?: { provider?: string; id?: string }): boolean {
	return model?.provider === "anthropic" || /claude/i.test(model?.id ?? "");
}

/** The scale factor the provider applies to an image of this shape. */
function providerScale(width: number, height: number): number {
	const byEdge = PROVIDER_EDGE / Math.max(width, height);
	const byArea = Math.sqrt(PROVIDER_PIXELS / (width * height));
	return Math.min(1, byEdge, byArea);
}

/** The dimensions the provider will actually bill — the largest size worth sending. */
export function providerFit(width: number, height: number): { width: number; height: number } {
	if (width <= 0 || height <= 0) return { width: 0, height: 0 };
	const scale = providerScale(width, height);
	return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Tokens for an image of these dimensions, measured on the size the provider bills. */
export function imageTokens(width: number, height: number): number {
	const fit = providerFit(width, height);
	return Math.ceil((fit.width * fit.height) / PIXELS_PER_TOKEN);
}

/**
 * The size to resize to, or `undefined` when there is nothing to do: an image
 * already at or below what the provider would use is left exactly as it is.
 *
 * `fitToProvider: false` is the non-Anthropic case: only an explicit `maxDim`
 * cap does anything, applied to the raw dimensions.
 */
export function target(width: number, height: number, maxDim: number | undefined, fitToProvider = true): { width: number; height: number } | undefined {
	const fit = fitToProvider ? providerFit(width, height) : { width, height };
	if (maxDim === undefined) {
		return fitToProvider && (fit.width < width || fit.height < height) ? fit : undefined;
	}
	const scale = Math.min(1, maxDim / Math.max(fit.width, fit.height));
	const wanted = { width: Math.max(1, Math.floor(fit.width * scale)), height: Math.max(1, Math.floor(fit.height * scale)) };
	return wanted.width < width || wanted.height < height ? wanted : undefined;
}

/** Whether a block is worth decoding at all, judged on base64 length. */
export function shouldTry(base64Length: number, minBytes: number): boolean {
	return base64Length > minBytes;
}

/**
 * Whether to keep what the resizer produced. It picks whichever of PNG and
 * JPEG comes out smaller and can hand back something larger than it was given;
 * anything that is not a clear win is discarded.
 */
export function worthKeeping(before: number, after: number): boolean {
	return after > 0 && after < before * (1 - WORTH_IT);
}

export interface Saving {
	bytes: number;
	tokens: number;
}

export function saving(before: { bytes: number; width: number; height: number }, after: { bytes: number; width: number; height: number }): Saving {
	return {
		bytes: before.bytes - after.bytes,
		tokens: imageTokens(before.width, before.height) - imageTokens(after.width, after.height),
	};
}

/** Pixels and base64 bytes of one image, as carried in the tool result. */
export interface ImageShape {
	width: number;
	height: number;
	bytes: number;
}

/**
 * What the renderer may say about one image. Stored in the tool result's
 * `details.images`; the model never sees it. `after` equals `before` until a
 * resize is kept. Width and height are 0 when the header was unreadable.
 */
export interface ImageDetail {
	before: ImageShape;
	after: ImageShape;
	tokens: number;
}

export function imageDetail(size: { width: number; height: number } | undefined, bytes: number): ImageDetail {
	const shape = { width: size?.width ?? 0, height: size?.height ?? 0, bytes };
	return { before: shape, after: shape, tokens: 0 };
}

/**
 * pi pairs a resized image with a coordinate note. Shrinking the pixels and
 * keeping the old note leaves the model measuring against a stale scale, so
 * the note is rewritten against its own "original" figure.
 */
const NOTE = /\[Image: original (\d+)x(\d+), displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]/;

/** The same wording pi uses, so the model meets one format, not two. */
export function dimensionNote(original: { width: number; height: number }, displayed: { width: number; height: number }): string {
	const scale = (original.width / displayed.width).toFixed(2);
	return `[Image: original ${original.width}x${original.height}, displayed at ${displayed.width}x${displayed.height}. Multiply coordinates by ${scale} to map to original image.]`;
}

export function rewriteNote(text: string, displayed: { width: number; height: number }): string | undefined {
	const m = NOTE.exec(text);
	if (!m || displayed.width <= 0) return undefined;
	return text.replace(NOTE, dimensionNote({ width: Number(m[1]), height: Number(m[2]) }, displayed));
}
