/**
 * Tool-output compaction. Pure: node builtins and core/ only, so the tests run
 * under bare node. The index wires it to pi's `tool_result` event.
 *
 * A tool result is re-sent on every later request of the session, so every
 * byte removed here is removed many times over. The passes, in order:
 *
 *   hygiene        ANSI, carriage-return replay, trailing whitespace   lossless
 *   identical fold `[+N identical lines]`                              lossless
 *   similar fold   logs only: first + `[+N similar lines]` + last      lossy, marked
 *   JSON → TOON    same data, fewer bytes                              content-lossless
 *   cap + spill    per-tool byte cap; full text goes to a spill file   lossy, marked
 *   token masking  logs only: `§1` + `[legend: §1=…]`                  lossless
 *
 * Markers sit at the top of head-kept results and at the bottom of tail-kept
 * ones, so a later truncation by pi itself never eats them.
 */
import { join } from "node:path";
import { fmtBytes } from "../../core/ledger.ts";
import { writeTextAtomic } from "../../core/paths.ts";
import { byteLength, foldIdenticalLines, headBytes, replayCarriageReturns, stripAnsi, tidyWhitespace } from "../../core/text.ts";
import { tryToon } from "../../core/toon.ts";

/** The subset of pi's TruncationResult this module reads. */
export interface TruncationLike {
	content: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	/** truncateHead only: the first line alone is over budget, so `content` is "". */
	firstLineExceedsLimit?: boolean;
}
export type Truncator = (content: string, options: { maxLines?: number; maxBytes?: number }) => TruncationLike;
/** pi's truncateHead/truncateTail, injected so this file stays pi-free. */
export interface Truncators {
	head: Truncator;
	tail: Truncator;
}

export interface CompactCaps {
	bash: number;
	grep: number;
	find: number;
	ls: number;
	read: number;
	delegate: number;
	web_fetch: number;
	session: number;
	default: number;
}

export interface OutputConfig {
	caps: CompactCaps;
	toon: boolean;
	maskLogs: boolean;
}

export const DEFAULT_CAPS: CompactCaps = {
	bash: 8 * 1024,
	grep: 16 * 1024,
	find: 8 * 1024,
	ls: 8 * 1024,
	read: 64 * 1024,
	delegate: 16 * 1024,
	web_fetch: 16 * 1024,
	session: 16 * 1024,
	default: 16 * 1024,
};

/** An error result always keeps at least this many trailing lines verbatim. */
export const ERROR_TAIL_LINES = 40;
/** Similar-line folds must be this long to pay for the three lines they keep. */
export const SIMILAR_MIN_RUN = 5;
/** A token must recur this often before it earns a legend entry. */
export const MASK_MIN_COUNT = 3;
/** Masking is applied only when it removes this fraction of the bytes. */
export const MASK_MIN_SAVING = 0.12;

const NO_LINE_LIMIT = 1_000_000_000;

export interface CompactRequest {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown> | undefined;
	text: string;
	isError: boolean;
}

export interface CompactResult {
	text: string;
	before: number;
	after: number;
	/** Set when the result was cut and the full text written to disk. */
	spillPath?: string;
}

/** What the pipeline does for one tool. */
export interface Policy {
	keep: "head" | "tail";
	cap: number;
	/** Fold runs of lines that differ only in volatile fields. */
	similar: boolean;
	/** Replace long repeated tokens with §n + legend. */
	mask: boolean;
	/** Re-encode JSON as TOON. */
	toon: boolean;
	/** Cut with a "read … offset=N" note instead of a spill file. */
	offsetNote: boolean;
}

/** A path whose content is a log: the one kind of read where lossy folding is all win. */
export function isLogPath(path: unknown): boolean {
	if (typeof path !== "string") return false;
	return /\.(log|logs|out|err|trace)(?:[.-]\d+)?(?:\.gz)?$/i.test(path) || /(^|[\\/])logs?[\\/]/i.test(path);
}

export function policyFor(toolName: string, input: Record<string, unknown> | undefined, caps: CompactCaps): Policy {
	const off = { similar: false, mask: false, toon: false, offsetNote: false };
	switch (toolName) {
		case "bash":
		case "powershell":
			return { keep: "tail", cap: caps.bash, similar: true, mask: true, toon: true, offsetNote: false };
		case "read": {
			const log = isLogPath(input?.path);
			return { keep: "head", cap: caps.read, similar: log, mask: log, toon: false, offsetNote: true };
		}
		case "grep":
			return { keep: "head", cap: caps.grep, ...off };
		case "find":
			return { keep: "head", cap: caps.find, ...off };
		case "ls":
			return { keep: "head", cap: caps.ls, ...off };
		case "edit":
		case "write":
			return { keep: "head", cap: caps.default, ...off };
		case "delegate":
			return { keep: "head", cap: caps.delegate, similar: false, mask: true, toon: true, offsetNote: false };
		case "web_fetch":
			return { keep: "head", cap: caps.web_fetch, similar: false, mask: false, toon: true, offsetNote: false };
		default:
			return { keep: "head", cap: toolName.startsWith("session_") ? caps.session : caps.default, similar: false, mask: false, toon: true, offsetNote: false };
	}
}

// ---------------------------------------------------------------------------
// Similar-line folding (logs)

/** Ordered: the specific before the general, or a timestamp dies as three numbers. */
const VOLATILE: RegExp[] = [
	/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
	/\b[A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}\b/g,
	/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g,
	/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
	// Hex ids need a digit somewhere, or English words spelled in a-f ("efface") mask too.
	/\b(?:0x)?(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,}\b/g,
	/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g,
	// The unit tail (0ms, 4KiB, 87%) is part of the number token.
	/\b\d+(?:\.\d+)?(?:[a-zA-Z%]{1,4})?\b/g,
];

/** The grouping key for similar-line folding. Never emitted. */
export function maskLine(line: string): string {
	let out = line;
	for (const re of VOLATILE) out = out.replace(re, "\0");
	return out;
}

/** A mask that is all volatility is data, not a log pattern. */
function foldable(mask: string): boolean {
	return /[A-Za-z]{3}/.test(mask);
}

/**
 * Runs of ≥ minRun mask-identical lines become first + `[+N similar lines]` + last.
 * Existing `[+…]` markers are never grouped, so counts stay honest.
 */
export function foldSimilarLines(text: string, minRun = SIMILAR_MIN_RUN): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "" || line.startsWith("[+")) {
			out.push(line);
			i++;
			continue;
		}
		const key = maskLine(line);
		let end = i + 1;
		while (end < lines.length && lines[end].trim() !== "" && !lines[end].startsWith("[+") && maskLine(lines[end]) === key) end++;
		const run = end - i;
		if (run < minRun || !foldable(key)) {
			for (let k = i; k < end; k++) out.push(lines[k]);
		} else {
			out.push(lines[i], `[+${run - 2} similar lines]`, lines[end - 1]);
		}
		i = end;
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Token masking (dictionary compression with a legend)

const MASK_CHAR = "§";
const LEGEND_PREFIX = "[legend: ";

/** Shortest path or URL prefix worth a legend entry. */
const MIN_PREFIX = 24;

/** Candidate tokens. None may contain whitespace or `]`, since the legend is space-separated and `]`-terminated. */
const TOKEN_PATTERNS: Array<{ re: RegExp; prefixes: boolean }> = [
	// Absolute paths, unix or windows, ≥ 24 chars. Their directory prefixes are candidates too.
	{ re: /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![A-Za-z0-9/])\/)[^\s"'`,;:()[\]<>|]{21,}/g, prefixes: true },
	// URL prefixes: scheme, host and every directory segment, up to the last slash.
	{ re: /https?:\/\/[^\s"'`<>()[\]]*\//g, prefixes: true },
	// UUIDs.
	{ re: /(?<![A-Za-z0-9])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9])/g, prefixes: false },
	// Long hex / base64url-ish tokens ≥ 20 chars that contain a digit (no `/`, so paths stay with the path pattern).
	{ re: /(?<![A-Za-z0-9+=_-])(?=[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{20,}(?![A-Za-z0-9+=_-])/g, prefixes: false },
	// Fully-qualified class / logger names: at least two dotted lowercase segments then a capitalised name.
	{ re: /(?<![A-Za-z0-9_.$])(?:[a-z][a-z0-9_]*\.){2,}[A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)*(?![A-Za-z0-9_$])/g, prefixes: false },
];

/** Every separator-terminated prefix of a path or URL that is long enough to pay for itself. */
function dirPrefixes(token: string): string[] {
	const out: string[] = [];
	for (let j = 1; j < token.length - 1; j++) {
		if ((token[j] === "/" || token[j] === "\\") && j + 1 >= MIN_PREFIX) out.push(token.slice(0, j + 1));
	}
	return out;
}

export interface Masked {
	text: string;
	legend: string;
}

/** Parse a legend line back into its map. Exported so callers can unmask a spilled result. */
export function parseLegend(line: string): Map<string, string> | undefined {
	if (!line.startsWith(LEGEND_PREFIX) || !line.endsWith("]")) return undefined;
	const map = new Map<string, string>();
	for (const entry of line.slice(LEGEND_PREFIX.length, -1).split(" ")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) return undefined;
		map.set(entry.slice(0, eq), entry.slice(eq + 1));
	}
	return map;
}

/** Rebuild the original text from a masked body and its legend line. */
export function unmask(text: string, legend: string): string {
	const map = parseLegend(legend);
	if (!map) return text;
	return text.replace(/§\d+/g, (m) => map.get(m) ?? m);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, token: string): number {
	let n = 0;
	let at = text.indexOf(token);
	while (at !== -1) {
		n++;
		at = text.indexOf(token, at + token.length);
	}
	return n;
}

/**
 * Replace long tokens that occur ≥ MASK_MIN_COUNT times with §1, §2… and return
 * the legend line. Undefined when nothing qualifies, when the text already uses
 * `§`, when the round trip is not exact, or when the saving is under MASK_MIN_SAVING.
 */
export function maskTokens(text: string, minSaving = MASK_MIN_SAVING): Masked | undefined {
	if (text.includes(MASK_CHAR)) return undefined;
	const counts = new Map<string, number>();
	const seen = new Set<string>();
	const add = (token: string) => counts.set(token, (counts.get(token) ?? 0) + 1);
	for (const { re, prefixes } of TOKEN_PATTERNS) {
		re.lastIndex = 0;
		for (let m = re.exec(text); m !== null; m = re.exec(text)) {
			const token = m[0];
			if (token.includes("]")) continue;
			// Two patterns matching the same span (a UUID is also hex-ish) count once.
			const span = `${m.index}:${token.length}`;
			if (seen.has(span)) continue;
			seen.add(span);
			add(token);
			if (prefixes) for (const prefix of dirPrefixes(token)) add(prefix);
		}
	}
	// Longest first: a UUID inside a path is subsumed by the path when the path itself recurs.
	const candidates = [...counts.entries()]
		.filter(([, n]) => n >= MASK_MIN_COUNT)
		.map(([token]) => token)
		.sort((a, b) => b.length - a.length || a.localeCompare(b));
	if (candidates.length === 0) return undefined;

	let out = text;
	const legend: string[] = [];
	for (const token of candidates) {
		const id = `${MASK_CHAR}${legend.length + 1}`;
		const n = countOccurrences(out, token);
		if (n < MASK_MIN_COUNT) continue;
		// Net saving must be positive after paying for the legend entry.
		if (n * (token.length - id.length) <= token.length + id.length + 2) continue;
		out = out.replace(new RegExp(escapeRegExp(token), "g"), id);
		legend.push(`${id}=${token}`);
	}
	if (legend.length === 0) return undefined;
	const legendLine = `${LEGEND_PREFIX}${legend.join(" ")}]`;
	const before = byteLength(text);
	const after = byteLength(out) + byteLength(legendLine) + 1;
	if (after > before * (1 - minSaving)) return undefined;
	if (unmask(out, legendLine) !== text) return undefined;
	return { text: out, legend: legendLine };
}

// ---------------------------------------------------------------------------
// The pipeline

function hygiene(text: string): string {
	return tidyWhitespace(replayCarriageReturns(stripAnsi(text)));
}

/** ANSI and CR replay only: these never change the line count, which the read offset note relies on. */
function lineSafeHygiene(text: string): string {
	return replayCarriageReturns(stripAnsi(text)).replace(/\r\n?/g, "\n");
}

function spillName(toolCallId: string): string {
	return `${toolCallId.replace(/[^A-Za-z0-9_.-]/g, "_") || "result"}.txt`;
}

function lastLines(text: string, n: number): string {
	const lines = text.split("\n");
	return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function cutStats(t: TruncationLike): string {
	return `kept ${t.outputLines} of ${t.totalLines} lines, ${fmtBytes(t.totalBytes)} -> ${fmtBytes(t.outputBytes)}`;
}

/** Assemble body + legend + marker with the markers on the side the cap keeps. */
function assemble(body: string, keep: "head" | "tail", legend: string | undefined, marker: string | undefined): string {
	const extras = [legend, marker].filter((s): s is string => !!s);
	if (extras.length === 0) return body;
	if (keep === "head") return [marker, legend].filter(Boolean).concat(body).join("\n");
	return [body, legend, marker].filter(Boolean).join("\n");
}

interface Capped {
	/** What is kept: the whole text when nothing was cut. */
	body: string;
	marker?: string;
	spillPath?: string;
}

/**
 * Cut `text` to `maxBytes` on the kept side. `continuation` says where a
 * line-cut result picks up (the read offset note); without one the full text
 * spills to `spillPath`.
 *
 * Two edges pi's truncators leave to the caller:
 * - A first line over budget comes back from truncateHead as "" with
 *   `firstLineExceedsLimit`. Emitted as-is, a minified file read as "kept 0 of
 *   1 lines; read … offset=1" and sent the model round the same read forever.
 *   It is cut on a UTF-8 boundary instead, and always spills: a mid-line cut
 *   has no line offset to continue from.
 * - The cut must reclaim more than its marker costs. A result a few bytes over
 *   the cap would otherwise lose a line and grow by the marker, re-sent on
 *   every later request. Such a result stays whole and nothing spills.
 */
function capText(text: string, keep: "head" | "tail", maxBytes: number, tr: Truncators, spillPath: string, continuation?: (keptLines: number) => string): Capped {
	const t = (keep === "tail" ? tr.tail : tr.head)(text, { maxBytes, maxLines: NO_LINE_LIMIT });
	if (!t.truncated) return { body: text };
	const partial = t.firstLineExceedsLimit === true;
	const body = partial ? headBytes(text, maxBytes) : t.content;
	const stats = partial ? `kept the first ${fmtBytes(byteLength(body))} of ${fmtBytes(t.totalBytes)}, cut inside line 1 of ${t.totalLines}` : cutStats(t);
	const cite = partial || !continuation ? undefined : continuation(t.outputLines);
	const marker = `[compact: ${stats}; ${cite ?? `full output: ${spillPath}`}]`;
	if (byteLength(text) - byteLength(assemble(body, keep, undefined, marker)) < byteLength(marker)) return { body: text };
	if (cite !== undefined) return { body, marker };
	writeTextAtomic(spillPath, text);
	return { body, marker, spillPath };
}

export function compactOutput(req: CompactRequest, cfg: OutputConfig, tr: Truncators, spillDir: string): CompactResult {
	const before = byteLength(req.text);
	if (req.text === "") return { text: req.text, before, after: before };
	const policy = policyFor(req.toolName, req.input, cfg.caps);
	const path = typeof req.input?.path === "string" ? req.input.path : "<path>";
	const spillTo = join(spillDir, spillName(req.toolCallId));

	// Errors: hygiene and a tail cap only, and the last ERROR_TAIL_LINES lines stay verbatim.
	if (req.isError) {
		const clean = hygiene(req.text);
		const floor = byteLength(lastLines(clean, ERROR_TAIL_LINES));
		const c = capText(clean, "tail", Math.max(policy.cap, floor), tr, spillTo);
		const text = assemble(c.body, "tail", undefined, c.marker);
		return { text, before, after: byteLength(text), spillPath: c.spillPath };
	}

	let text: string;
	let marker: string | undefined;
	let spillPath: string | undefined;
	let tooned = false;

	if (policy.offsetNote) {
		// read: cap on line-preserving text so the offset in the note is a real file line.
		// A source file stays byte-exact (an edit must be able to quote it); only a
		// log-looking path gets hygiene and folding.
		const raw = policy.similar ? lineSafeHygiene(req.text) : req.text;
		const start = typeof req.input?.offset === "number" ? req.input.offset : 1;
		const c = capText(raw, "head", policy.cap, tr, spillTo, (kept) => `read ${path} with offset=${start + kept} for the rest`);
		marker = c.marker;
		spillPath = c.spillPath;
		text = policy.similar ? foldSimilarLines(foldIdenticalLines(tidyWhitespace(c.body))) : c.body;
	} else {
		text = foldIdenticalLines(hygiene(req.text));
		if (policy.similar) text = foldSimilarLines(text);
		if (cfg.toon && policy.toon) {
			const r = tryToon(text);
			if (r) {
				text = r.whole ? `[toon]\n${r.toon}` : r.toon;
				tooned = true;
			}
		}
		const c = capText(text, policy.keep, policy.cap, tr, spillTo);
		text = c.body;
		marker = c.marker;
		spillPath = c.spillPath;
	}

	let legend: string | undefined;
	if (cfg.maskLogs && policy.mask && !tooned) {
		const m = maskTokens(text);
		if (m) {
			text = m.text;
			legend = m.legend;
		}
	}

	const out = assemble(text, policy.keep, legend, marker);
	return { text: out, before, after: byteLength(out), spillPath };
}
