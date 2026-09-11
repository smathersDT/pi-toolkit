/**
 * JSON → TOON (Token-Oriented Object Notation, spec v4.1).
 *
 * TOON spends one header line per table where JSON spends a key and two
 * quotes per cell. On the shape that dominates tool output — an array of
 * uniform flat objects, which is what every list endpoint returns — that is
 * most of the bytes. On deep or mixed shapes it saves only punctuation, so
 * `tryToon` refuses any conversion under TOON_MIN_SAVING: a conversion that
 * saves 8% is one the model has to learn to read for nothing.
 *
 * Content-lossless (keys, order and values survive), format-lossy (the exact
 * JSON bytes do not). No pi imports.
 */

const INDENT = "  ";
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const NUMERIC_LIKE = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
// biome-ignore lint: control characters are the point here
const UNSAFE_CHARS = /[:"\\[\]{},\x00-\x1f]/;

/** Below this saving a conversion is refused. */
export const TOON_MIN_SAVING = 0.15;

type Primitive = null | boolean | number | string;

function isPrimitive(v: unknown): v is Primitive | undefined | bigint {
	return v === null || v === undefined || typeof v !== "object";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Entries of an object as JSON would see them: undefined and functions dropped. */
function entriesOf(obj: Record<string, unknown>): Array<[string, unknown]> {
	return Object.entries(obj).filter(([, v]) => v !== undefined && typeof v !== "function" && typeof v !== "symbol");
}

/** §7.2: a string may go bare only when nothing could misread it. */
export function needsQuotes(s: string): boolean {
	if (s === "") return true;
	if (/^[ \t]|[ \t]$/.test(s)) return true;
	if (s === "true" || s === "false" || s === "null") return true;
	if (NUMERIC_LIKE.test(s)) return true;
	if (UNSAFE_CHARS.test(s)) return true;
	return s[0] === "-" || s[0] === "#";
}

function quote(s: string): string {
	return JSON.stringify(s);
}

function encodeKey(k: string): string {
	return BARE_KEY.test(k) ? k : quote(k);
}

/** §2: canonical decimal in the safe range; -0 becomes 0; non-finite becomes null. */
function encodeNumber(n: number): string {
	if (!Number.isFinite(n)) return "null";
	if (n === 0) return "0";
	return String(n);
}

function encodePrimitive(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "boolean") return v ? "true" : "false";
	if (typeof v === "number") return encodeNumber(v);
	if (typeof v === "bigint") return String(v);
	if (typeof v === "string") return needsQuotes(v) ? quote(v) : v;
	if (v instanceof Date) return encodePrimitive(v.toISOString());
	return quote(String(v));
}

/**
 * §9.3: an array is tabular when every element is an object with the same
 * non-empty key set and only primitive values. Returns the header keys.
 */
function tabularKeys(arr: unknown[]): string[] | undefined {
	if (arr.length === 0 || !isPlainObject(arr[0])) return undefined;
	const keys = entriesOf(arr[0]).map(([k]) => k);
	if (keys.length === 0) return undefined;
	const keySet = new Set(keys);
	for (const item of arr) {
		if (!isPlainObject(item)) return undefined;
		const entries = entriesOf(item);
		if (entries.length !== keys.length) return undefined;
		for (const [k, v] of entries) {
			if (!keySet.has(k) || !isPrimitive(v) || v instanceof Date) return undefined;
		}
	}
	return keys;
}

function push(lines: string[], depth: number, s: string): void {
	lines.push(INDENT.repeat(depth) + s);
}

/** Array under `label` (empty label = root or list item) at `depth`. */
function encodeArray(lines: string[], label: string, arr: unknown[], depth: number): void {
	const name = label === "" ? "" : encodeKey(label);
	if (arr.length === 0) {
		push(lines, depth, name === "" ? "[]" : `${name}: []`);
		return;
	}
	if (arr.every((v) => isPrimitive(v))) {
		push(lines, depth, `${name}[${arr.length}]: ${arr.map(encodePrimitive).join(",")}`);
		return;
	}
	const keys = tabularKeys(arr);
	if (keys) {
		push(lines, depth, `${name}[${arr.length}]{${keys.map(encodeKey).join(",")}}:`);
		for (const item of arr as Record<string, unknown>[]) {
			push(lines, depth + 1, keys.map((k) => encodePrimitive(item[k])).join(","));
		}
		return;
	}
	push(lines, depth, `${name}[${arr.length}]:`);
	for (const item of arr) encodeListItem(lines, item, depth + 1);
}

/** §9.4 / §10: one `- ` item; the first field of an object rides on the hyphen line. */
function encodeListItem(lines: string[], item: unknown, depth: number): void {
	if (isPrimitive(item)) {
		push(lines, depth, `- ${encodePrimitive(item)}`);
		return;
	}
	const start = lines.length;
	if (Array.isArray(item)) {
		encodeArray(lines, "", item, depth + 1);
	} else {
		const entries = entriesOf(item as Record<string, unknown>);
		if (entries.length === 0) {
			push(lines, depth, "-");
			return;
		}
		for (const [k, v] of entries) encodeEntry(lines, k, v, depth + 1);
	}
	// Hoist the first line onto the hyphen: "  - " is exactly one indent wider than "  ".
	lines[start] = `${INDENT.repeat(depth)}- ${lines[start].slice(INDENT.length * (depth + 1))}`;
}

function encodeEntry(lines: string[], k: string, v: unknown, depth: number): void {
	if (Array.isArray(v)) {
		encodeArray(lines, k, v, depth);
		return;
	}
	if (isPlainObject(v)) {
		push(lines, depth, `${encodeKey(k)}:`);
		for (const [ck, cv] of entriesOf(v)) encodeEntry(lines, ck, cv, depth + 1);
		return;
	}
	push(lines, depth, `${encodeKey(k)}: ${encodePrimitive(v)}`);
}

/** Encode any JSON-like value. Never throws on JSON.parse output. */
export function encodeToon(value: unknown): string {
	if (isPrimitive(value)) return encodePrimitive(value);
	const lines: string[] = [];
	if (Array.isArray(value)) {
		encodeArray(lines, "", value, 0);
	} else if (isPlainObject(value)) {
		for (const [k, v] of entriesOf(value)) encodeEntry(lines, k, v, 0);
	} else {
		return encodePrimitive(value);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------

export interface ToonOptions {
	/** JSON smaller than this is left alone (bytes). */
	minBytes?: number;
	/** Required fraction of bytes removed; default TOON_MIN_SAVING. */
	minSaving?: number;
}

export interface ToonResult {
	/** The full replacement text: TOON alone, or the input with each fenced block re-encoded. */
	toon: string;
	/** Bytes removed. */
	saved: number;
	/** True when the whole text was JSON; false when only fenced blocks were converted. */
	whole: boolean;
}

function bytes(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

function convert(json: string, minBytes: number, minSaving: number): string | undefined {
	const size = bytes(json);
	if (size < minBytes) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object") return undefined;
	const toon = encodeToon(value);
	if (bytes(toon) > size * (1 - minSaving)) return undefined;
	return toon;
}

const FENCE = /```([\w-]*)[^\n]*\n([\s\S]*?)\n[ \t]*```/g;

/**
 * Re-encode `text` when it is JSON as a whole, or every ```json (or untagged
 * `{`/`[`) fenced block inside it, keeping only conversions that clear the
 * saving bar. Undefined when nothing qualified.
 */
export function tryToon(text: string, options: ToonOptions = {}): ToonResult | undefined {
	const minBytes = options.minBytes ?? 0;
	const minSaving = options.minSaving ?? TOON_MIN_SAVING;
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const toon = convert(trimmed, minBytes, minSaving);
		if (toon !== undefined) return { toon, saved: bytes(text) - bytes(toon), whole: true };
	}
	let out = "";
	let cursor = 0;
	let saved = 0;
	let applied = 0;
	FENCE.lastIndex = 0;
	for (let m = FENCE.exec(text); m !== null; m = FENCE.exec(text)) {
		const lang = m[1].toLowerCase();
		if (lang !== "json" && lang !== "") continue;
		const body = m[2].trim();
		if (!body.startsWith("{") && !body.startsWith("[")) continue;
		const toon = convert(body, minBytes, minSaving);
		if (toon === undefined) continue;
		const replacement = `\`\`\`toon\n${toon}\n\`\`\``;
		const gain = bytes(m[0]) - bytes(replacement);
		if (gain <= 0) continue;
		out += text.slice(cursor, m.index) + replacement;
		cursor = m.index + m[0].length;
		saved += gain;
		applied++;
	}
	if (applied === 0) return undefined;
	out += text.slice(cursor);
	return { toon: out, saved, whole: false };
}
