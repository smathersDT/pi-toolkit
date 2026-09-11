/**
 * User-prompt compaction. Pure; the index wires it to pi's `input` event.
 *
 * A pasted prompt sits in the prefix for the rest of the session exactly like
 * a tool result, so it gets the same lossless hygiene: ANSI, carriage-return
 * replay, trailing whitespace, runs of blank lines, identical-line folds
 * (outside fenced code) and TOON for large pasted JSON. Nothing here rewrites
 * code the user pasted beyond whitespace, and the transform is only offered
 * when it removes at least INPUT_MIN_SAVING of the bytes.
 */
import { byteLength, foldIdenticalLines, replayCarriageReturns, stripAnsi } from "../../core/text.ts";
import { tryToon } from "../../core/toon.ts";

/** Below this saving the rewrite is not worth the risk of surprising the user. */
export const INPUT_MIN_SAVING = 0.05;
/** Pasted JSON smaller than this stays as typed. */
export const INPUT_TOON_MIN_BYTES = 400;
/** Identical-line folds in prose need this many repeats. */
export const INPUT_FOLD_MIN_RUN = 3;

export interface InputOptions {
	toon?: boolean;
}

export interface InputResult {
	text: string;
	before: number;
	after: number;
}

/** Slash commands belong to pi and extensions; never touch them. */
export function isSlashCommand(text: string): boolean {
	return /^\s*\/\S/.test(text);
}

/** Fold identical lines only outside ``` fences: code is quoted exactly or not at all. */
export function foldOutsideFences(text: string, minRun = INPUT_FOLD_MIN_RUN): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let chunk: string[] = [];
	let inFence = false;
	const flush = () => {
		if (chunk.length > 0) out.push(foldIdenticalLines(chunk.join("\n"), minRun));
		chunk = [];
	};
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			if (!inFence) flush();
			inFence = !inFence;
			if (inFence) chunk.push(line);
			else {
				chunk.push(line);
				out.push(chunk.join("\n"));
				chunk = [];
			}
			continue;
		}
		chunk.push(line);
	}
	if (inFence) out.push(chunk.join("\n"));
	else flush();
	return out.join("\n");
}

/** Whitespace-only cleanup: CRLF, trailing spaces, three or more blank lines to one. */
export function tidyPrompt(text: string): string {
	return replayCarriageReturns(stripAnsi(text))
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{4,}/g, "\n\n");
}

export function compactInput(text: string, options: InputOptions = {}): InputResult | undefined {
	if (!text || isSlashCommand(text)) return undefined;
	const before = byteLength(text);
	let out = foldOutsideFences(tidyPrompt(text));
	if (options.toon !== false) {
		const r = tryToon(out, { minBytes: INPUT_TOON_MIN_BYTES });
		if (r) out = r.toon;
	}
	const after = byteLength(out);
	if (after > before * (1 - INPUT_MIN_SAVING)) return undefined;
	return { text: out, before, after };
}
