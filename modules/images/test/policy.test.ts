import assert from "node:assert/strict";
import { test } from "node:test";
import { dimensionNote, FLOOR_BYTES, imageTokens, PROVIDER_EDGE, PROVIDER_PIXELS, providerFit, providerFitApplies, rewriteNote, saving, shouldTry, target, worthKeeping } from "../policy.ts";

test("providerFit: the megapixel limit binds for a square, the edge limit for a wide image", () => {
	assert.deepEqual(providerFit(2000, 2000), { width: 1072, height: 1072 });
	assert.ok(1072 * 1072 <= PROVIDER_PIXELS);
	assert.ok(1072 < PROVIDER_EDGE, "the case an edge-only cap misses");
	const wide = providerFit(4000, 1000);
	assert.equal(Math.max(wide.width, wide.height), PROVIDER_EDGE);
	assert.ok(Math.abs(wide.width / wide.height - 4) < 0.01, "aspect ratio preserved");
	assert.deepEqual(providerFit(800, 600), { width: 800, height: 600 });
	assert.deepEqual(providerFit(0, 0), { width: 0, height: 0 });
});

test("imageTokens: 2000px, 1568px and 1072px squares cost the same — the provider resizes before it bills", () => {
	assert.equal(imageTokens(2000, 2000), imageTokens(1568, 1568));
	assert.equal(imageTokens(2000, 2000), imageTokens(1072, 1072));
	assert.ok(imageTokens(900, 900) < imageTokens(1072, 1072), "below the fit, tokens fall");
	assert.equal(imageTokens(800, 600), Math.ceil((800 * 600) / 750));
	assert.equal(imageTokens(0, 0), 0);
});

test("saving: 2000x2000 → 1072x1072 saves bytes and exactly zero tokens", () => {
	const honest = saving({ bytes: 400_000, width: 2000, height: 2000 }, { bytes: 115_000, width: 1072, height: 1072 });
	assert.deepEqual(honest, { bytes: 285_000, tokens: 0 });
	const traded = saving({ bytes: 400_000, width: 2000, height: 2000 }, { bytes: 60_000, width: 800, height: 800 });
	assert.ok(traded.tokens > 0, "a cap below the fit does save tokens");
});

test("target: provider fit by default, an explicit cap below it, never an upscale", () => {
	assert.deepEqual(target(2000, 2000, undefined), { width: 1072, height: 1072 });
	assert.equal(target(800, 600, undefined), undefined, "already within the limits: not re-encoded");
	const lower = target(2000, 2000, 800);
	assert.equal(Math.max(lower!.width, lower!.height), 800);
	assert.equal(target(800, 600, 4000), undefined, "a cap above the image never upscales");
	const capOnSmall = target(1000, 800, 500);
	assert.equal(Math.max(capOnSmall!.width, capOnSmall!.height), 500);
	assert.equal(target(4000, 4000, undefined, false), undefined, "no fit and no cap: nothing to do");
	const foreign = target(4000, 4000, 800, false);
	assert.equal(Math.max(foreign!.width, foreign!.height), 800, "a cap still applies without the fit");
});

test("providerFitApplies: Anthropic models through any gateway", () => {
	assert.equal(providerFitApplies({ provider: "anthropic", id: "claude-opus-5" }), true);
	assert.equal(providerFitApplies({ provider: "github-copilot", id: "claude-sonnet-4" }), true);
	assert.equal(providerFitApplies({ provider: "google", id: "gemini-2.5-pro" }), false);
	assert.equal(providerFitApplies(undefined), false);
});

test("shouldTry and worthKeeping thresholds", () => {
	assert.equal(shouldTry(FLOOR_BYTES + 1, FLOOR_BYTES), true);
	assert.equal(shouldTry(FLOOR_BYTES, FLOOR_BYTES), false);
	assert.equal(worthKeeping(100_000, 50_000), true);
	assert.equal(worthKeeping(100_000, 95_000), false, "a 5% saving is not worth a re-encode");
	assert.equal(worthKeeping(100_000, 140_000), false, "a resize that made it bigger is discarded");
	assert.equal(worthKeeping(100_000, 0), false);
});

test("the coordinate note is rewritten against its own original figure", () => {
	const stale = "Read image file [image/png]\n[Image: original 4000x4000, displayed at 2000x2000. Multiply coordinates by 2.00 to map to original image.]";
	const fixed = rewriteNote(stale, { width: 1072, height: 1072 });
	assert.equal(fixed, "Read image file [image/png]\n[Image: original 4000x4000, displayed at 1072x1072. Multiply coordinates by 3.73 to map to original image.]");
	assert.equal(rewriteNote("Read image file [image/png]", { width: 1072, height: 1072 }), undefined);
	const minted = dimensionNote({ width: 2000, height: 2000 }, { width: 1072, height: 1072 });
	assert.ok(rewriteNote(minted, { width: 536, height: 536 })?.includes("displayed at 536x536"));
});
