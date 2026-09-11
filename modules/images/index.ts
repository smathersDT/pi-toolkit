/**
 * images — stop carrying screenshot pixels no provider was ever going to look at.
 *
 * pi resizes images on the way in to 2000x2000: a ceiling against an enormous
 * file, not a budget. Anthropic bills an image after shrinking it to a 1568px
 * edge and ~1.15 megapixels, so a 2000x2000 screenshot is billed as 1072x1072
 * and every pixel above that is decoded, transmitted, written into the session
 * file and re-sent on every later request for nothing. Measured over 229
 * sessions: 42MB of base64, 71% of every byte the `read` tool returned.
 *
 * The default is "send exactly what the provider was going to use": bytes off
 * every request, zero tokens lost, and the token line honestly reads zero.
 * Tokens only fall below that point (`maxDim` in settings), paid for in detail.
 * The fit numbers are Anthropic's, so the default resize runs only for
 * Anthropic-family models; elsewhere only an explicit `maxDim` cap resizes.
 *
 * Runs on `tool_result`, before the result is written into the session, so the
 * smaller image is what gets stored and cached. pi's coordinate note beside a
 * resized image is rewritten to match. Anything unreadable passes through.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
import { fmtBytes } from "../../core/ledger.ts";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { dimensions } from "./dimensions.ts";
import { dimensionNote, FLOOR_BYTES, type ImageDetail, imageDetail, PROVIDER_EDGE, providerFitApplies, rewriteNote, saving, shouldTry, target, worthKeeping } from "./policy.ts";

/** `maxDim`: long-edge cap below the provider's fit, or undefined for the fit itself. `minBytes`: base64 length below which an image is left alone. */
const DEFAULTS = { maxDim: undefined as number | undefined, minBytes: FLOOR_BYTES };

type Block = TextContent | ImageContent;
type Resized = NonNullable<Awaited<ReturnType<typeof sdk.resizeImage>>>;

/** The same wording pi uses; its own helper when exported, the local copy otherwise. */
function freshNote(resized: Resized): string {
	try {
		const note = typeof sdk.formatDimensionNote === "function" ? sdk.formatDimensionNote(resized) : undefined;
		if (note) return note;
	} catch {}
	return dimensionNote({ width: resized.originalWidth, height: resized.originalHeight }, { width: resized.width, height: resized.height });
}

const module: ToolkitModule = {
	id: "images",
	label: "Image downsizing",
	description: "Shrink tool-result images to the size the provider bills anyway",
	default: true,
	order: 35,
	child: "always",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const raw = kit.config("images", DEFAULTS);
		// A cap under 256px leaves nothing a model can read; null/absent means the provider's fit.
		const maxDim = typeof raw.maxDim === "number" && Number.isFinite(raw.maxDim) && raw.maxDim >= 256 ? Math.floor(raw.maxDim) : undefined;
		const minBytes = typeof raw.minBytes === "number" && Number.isFinite(raw.minBytes) && raw.minBytes >= 0 ? raw.minBytes : FLOOR_BYTES;
		const stats = { seen: 0, resized: 0, before: 0, after: 0, tokens: 0, failed: 0 };

		pi.on("tool_result", async (event, ctx) => {
			try {
				const content = event.content as Block[] | undefined;
				if (!Array.isArray(content) || !content.some((block) => block.type === "image")) return undefined;
				const fitApplies = providerFitApplies(ctx?.model as { provider?: string; id?: string } | undefined);
				const mayResize = fitApplies || maxDim !== undefined;
				const next = [...content];
				let changed = false;
				// Note blocks already claimed by an image, by identity — indices shift
				// when a note is spliced in, and a second image walking back must not
				// rewrite the first image's note as its own.
				const claimed = new Set<unknown>();
				const images: ImageDetail[] = [];
				for (let index = 0; index < next.length; index++) {
					const block = next[index];
					if (block.type !== "image" || typeof block.data !== "string") continue;
					stats.seen++;
					const before = block.data.length;
					const bytes = Buffer.from(block.data, "base64");
					const size = dimensions(bytes);
					const detail = imageDetail(size, before);
					images.push(detail);
					if (!mayResize || !shouldTry(before, minBytes)) continue;
					// No readable header means no way to apply the megapixel limit, so fall
					// back to an edge cap — a worse resize, never a wrong one.
					const cap = fitApplies ? Math.min(maxDim ?? PROVIDER_EDGE, PROVIDER_EDGE) : (maxDim ?? PROVIDER_EDGE);
					const want = size ? target(size.width, size.height, maxDim, fitApplies) : { width: cap, height: cap };
					if (!want) continue;
					let resized: Resized | null = null;
					try {
						resized = await sdk.resizeImage(bytes, block.mimeType, { maxWidth: want.width, maxHeight: want.height });
					} catch {
						resized = null;
					}
					if (!resized) {
						stats.failed++;
						continue;
					}
					const after = resized.data.length;
					if (!worthKeeping(before, after)) continue;
					const cut = saving({ bytes: before, width: resized.originalWidth, height: resized.originalHeight }, { bytes: after, width: resized.width, height: resized.height });
					// The token formula is Anthropic's; on another family the honest claim is zero.
					if (!fitApplies) cut.tokens = 0;
					next[index] = { ...block, data: resized.data, mimeType: resized.mimeType };
					const displayed = { width: resized.width, height: resized.height };
					let annotated = false;
					for (let j = index - 1; j >= 0; j--) {
						const prior = next[j];
						if (prior.type !== "text" || claimed.has(prior)) break;
						const updated = rewriteNote(prior.text, displayed);
						if (updated !== undefined) {
							const rewritten = { ...prior, text: updated };
							next[j] = rewritten;
							claimed.add(rewritten);
							annotated = true;
							break;
						}
					}
					if (!annotated) {
						const fresh: TextContent = { type: "text", text: freshNote(resized) };
						claimed.add(fresh);
						next.splice(index + 1, 0, fresh);
					}
					changed = true;
					detail.before = { width: resized.originalWidth, height: resized.originalHeight, bytes: before };
					detail.after = { width: resized.width, height: resized.height, bytes: after };
					detail.tokens = cut.tokens;
					stats.resized++;
					stats.before += before;
					stats.after += after;
					stats.tokens += cut.tokens;
					kit.ledger.add("images", before, after);
				}
				// `details` never reaches the model; it is what the renderer reads.
				const prior = event.details;
				const details = { ...(prior && typeof prior === "object" ? (prior as object) : {}), images };
				return changed ? { content: next, details } : { details };
			} catch (error) {
				kit.log("images", `hook failed: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		});

		pi.on("session_start", () => {
			stats.seen = 0;
			stats.resized = 0;
			stats.before = 0;
			stats.after = 0;
			stats.tokens = 0;
			stats.failed = 0;
		});

		pi.registerCommand("images", {
			description: "What image downsizing saved this session",
			handler: async () => {
				const mode = maxDim !== undefined ? `cap ${maxDim}px` : "provider fit";
				const lines: string[] = [];
				if (stats.resized === 0) {
					lines.push(`nothing resized yet — ${stats.seen} image${stats.seen === 1 ? "" : "s"} seen${stats.failed > 0 ? `, ${stats.failed} could not be decoded` : ""}`);
				} else {
					lines.push(`${stats.resized} of ${stats.seen} images resized: ${fmtBytes(stats.before)} → ${fmtBytes(stats.after)} off every later request`);
					lines.push(stats.tokens > 0 ? `~${stats.tokens.toLocaleString()} image tokens saved (below the provider's fit)` : "no token saving, and none expected: this is the size the provider bills anyway");
				}
				kit.print("images", [mode], lines);
			},
		});
	},
};

export default module;
