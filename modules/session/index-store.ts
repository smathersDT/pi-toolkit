/**
 * Session memory store: turns pi session transcripts (JSONL) into small
 * per-file indexes and searches them. No pi imports, so tests run under bare
 * node and the same code serves the tools, the /sessions command and scripts.
 *
 * Index design
 *   <agentDir>/toolkit/session-index/<sha1(session path)>.json
 *   { version, file, size, mtimeMs, sessionId, cwd, timestamp, name?, messages }
 *   messages: [{ id, role: "user"|"assistant", text (≤ 4000 chars), ts }]
 *
 * A session file is streamed line by line (node:readline) exactly once per
 * (size, mtime) pair; the index is reused until the file changes. Only user
 * and assistant text blocks are kept — no thinking, tool calls or tool
 * results — which keeps two weeks of transcripts down to a few megabytes of
 * cache that a search loads in well under a second.
 */
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readJson, writeTextAtomic } from "../../core/paths.ts";

export const DEFAULT_DAYS = 14;
/** Characters kept per message in the index. */
export const TEXT_CAP = 4000;
/** Characters per page returned by `read`. */
export const PAGE_CHARS = 12000;
/** Messages per page returned by `read`. */
export const READ_LIMIT = 8;
/** Characters kept on each side of the first hit in a search excerpt. */
export const EXCERPT_RADIUS = 160;

const INDEX_VERSION = 1;
const DAY_MS = 86_400_000;
/** Session files indexed concurrently on a cold search. */
const POOL = 6;
/** Bonus a user message gets over an assistant message with the same hits. */
const USER_BONUS = 1.5;

export type Role = "user" | "assistant";

export interface ExtractedMessage {
	id: string;
	role: Role;
	text: string;
	/** Unix ms. */
	timestamp: number;
}

export interface SessionScan {
	sessionId: string;
	cwd: string;
	/** ISO timestamp from the header. */
	timestamp: string;
	name?: string;
	messages: ExtractedMessage[];
}

export interface SessionFileInfo {
	file: string;
	size: number;
	mtimeMs: number;
}

export interface StoredMessage {
	id: string;
	role: Role;
	text: string;
	ts: number;
}

export interface SessionIndex {
	version: number;
	file: string;
	size: number;
	mtimeMs: number;
	sessionId: string;
	cwd: string;
	timestamp: string;
	name?: string;
	messages: StoredMessage[];
}

export interface StoreOptions {
	/** Override the cache directory (default `<agentDir>/toolkit/session-index`). */
	cacheDir?: string;
	/** The current session file, never indexed or returned. */
	exclude?: string;
	/** Only sessions modified within this many days. */
	days?: number;
	/** Clock override for tests. */
	now?: number;
}

export interface ListOptions {
	days?: number;
	exclude?: string;
	now?: number;
}

export interface IndexStats {
	/** Session files in the window. */
	files: number;
	/** Files parsed on this call. */
	scanned: number;
	/** Files served from the cache. */
	cached: number;
	ms: number;
}

export interface SearchOptions extends StoreOptions {
	query: string;
	limit?: number;
	/** Only sessions whose cwd is this path or below. */
	cwd?: string;
}

export interface SearchResult {
	sessionId: string;
	/** Shortest prefix of sessionId unique among the indexed sessions (8 chars normally). */
	shortId: string;
	file: string;
	cwd: string;
	name?: string;
	/** YYYY-MM-DD of the message. */
	date: string;
	messageId: string;
	role: Role;
	/** One line, ±EXCERPT_RADIUS chars around the first hit. */
	excerpt: string;
	score: number;
	ts: number;
}

export interface SearchOutput {
	results: SearchResult[];
	/** True when no message matched every term and the results match any term. */
	partial: boolean;
	terms: string[];
	stats: IndexStats;
}

export interface ReadOptions extends StoreOptions {
	file?: string;
	/** Full id or a prefix (the short id printed by search). */
	sessionId?: string;
	/** Anchor: the page starts 2 messages before it. */
	messageId?: string;
	/** Start index in file order (ignored when messageId is given). */
	offset?: number;
	limit?: number;
	pageChars?: number;
}

export interface ReadOutput {
	sessionId: string;
	file: string;
	cwd: string;
	name?: string;
	total: number;
	start: number;
	count: number;
	/** `[<role> <time>] text` per message. */
	lines: string[];
	text: string;
	next_offset?: number;
	next_message_id?: string;
}

// ---------------------------------------------------------------------------
// Listing

/** Session files under `<agentDir>/sessions/**` modified within `days`, newest first. */
export function listSessionFiles(agentDir: string, opts: ListOptions = {}): SessionFileInfo[] {
	const days = opts.days ?? DEFAULT_DAYS;
	const cutoff = (opts.now ?? Date.now()) - days * DAY_MS;
	const excluded = opts.exclude ? normalizePath(opts.exclude) : undefined;
	const out: SessionFileInfo[] = [];
	const walk = (dir: string): void => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			let st: import("node:fs").Stats;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.mtimeMs < cutoff) continue;
			if (excluded && normalizePath(full) === excluded) continue;
			out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
		}
	};
	walk(join(agentDir, "sessions"));
	out.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return out;
}

/** The uuid part of `<timestamp>_<uuid>.jsonl`, if the name has that shape. */
export function sessionIdFromName(file: string): string | undefined {
	const m = /^.+?_([0-9a-f][0-9a-f-]{7,})\.jsonl$/i.exec(basename(file));
	return m?.[1];
}

// ---------------------------------------------------------------------------
// Extraction

/**
 * Stream one session file and collect the header, the latest session name and
 * every user/assistant text message. Malformed lines (a torn trailing write)
 * are skipped.
 */
export async function scanSession(file: string, maxText = TEXT_CAP): Promise<SessionScan> {
	const scan: SessionScan = { sessionId: "", cwd: "", timestamp: "", messages: [] };
	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const raw of rl) {
		const line = raw.trim();
		if (!line || line[0] !== "{") continue;
		// Tool results carry most of the bytes; skip them without parsing. The role
		// sits in the entry preamble, so a text payload cannot fake this.
		if (line.slice(0, 200).includes('"role":"toolResult"')) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		switch (entry.type) {
			case "session":
				scan.sessionId = str(entry.id);
				scan.cwd = str(entry.cwd);
				scan.timestamp = str(entry.timestamp);
				break;
			case "session_info":
				if (typeof entry.name === "string" && entry.name.trim()) scan.name = entry.name.trim();
				break;
			case "message": {
				const message = messageOf(entry, maxText);
				if (message) scan.messages.push(message);
				break;
			}
		}
	}
	if (!scan.sessionId) scan.sessionId = sessionIdFromName(file) ?? "";
	return scan;
}

/** User and assistant text messages of a session file, in file order. */
export async function extractMessages(file: string, maxText = TEXT_CAP): Promise<ExtractedMessage[]> {
	return (await scanSession(file, maxText)).messages;
}

function messageOf(entry: any, maxText: number): ExtractedMessage | undefined {
	const message = entry.message;
	if (!message || typeof message !== "object") return undefined;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return undefined;
	const text = textBlocks(message.content);
	if (text.trim().length < 3) return undefined;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(str(entry.timestamp)) || 0;
	return { id: str(entry.id), role, text: text.length > maxText ? text.slice(0, maxText) : text, timestamp };
}

/** Text blocks only: no thinking, no tool calls, no images. */
function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cache

export function cacheDirFor(agentDir: string, opts?: StoreOptions): string {
	return opts?.cacheDir ?? join(agentDir, "toolkit", "session-index");
}

export function cachePathFor(cacheDir: string, file: string): string {
	return join(cacheDir, `${createHash("sha1").update(normalizePath(file)).digest("hex")}.json`);
}

/** The index of one session file: from the cache when size and mtime match, else rebuilt. */
export async function loadIndex(info: SessionFileInfo, cacheDir: string): Promise<{ index: SessionIndex; cached: boolean }> {
	const path = cachePathFor(cacheDir, info.file);
	const hit = readJson<SessionIndex | undefined>(path, undefined);
	if (hit && hit.version === INDEX_VERSION && hit.size === info.size && hit.mtimeMs === info.mtimeMs && Array.isArray(hit.messages)) {
		return { index: hit, cached: true };
	}
	const scan = await scanSession(info.file);
	const index: SessionIndex = {
		version: INDEX_VERSION,
		file: info.file,
		size: info.size,
		mtimeMs: info.mtimeMs,
		sessionId: scan.sessionId,
		cwd: scan.cwd,
		timestamp: scan.timestamp,
		name: scan.name,
		messages: scan.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, ts: m.timestamp })),
	};
	try {
		writeTextAtomic(path, JSON.stringify(index));
	} catch {
		// A read-only cache dir only costs a rescan next time.
	}
	return { index, cached: false };
}

/** Indexes of every session file in the window, newest first. Unreadable files are skipped. */
export async function indexSessions(agentDir: string, opts: StoreOptions = {}): Promise<{ indexes: SessionIndex[]; stats: IndexStats }> {
	const started = Date.now();
	const files = listSessionFiles(agentDir, { days: opts.days, exclude: opts.exclude, now: opts.now });
	const cacheDir = cacheDirFor(agentDir, opts);
	let scanned = 0;
	let cached = 0;
	const loaded = await mapPool(files, POOL, async (info) => {
		try {
			const r = await loadIndex(info, cacheDir);
			if (r.cached) cached++;
			else scanned++;
			return r.index;
		} catch {
			return undefined;
		}
	});
	const indexes = loaded.filter((x): x is SessionIndex => x !== undefined);
	return { indexes, stats: { files: files.length, scanned, cached, ms: Date.now() - started } };
}

// ---------------------------------------------------------------------------
// Search

/** Literal lowercase terms, deduplicated, in query order. */
export function termsOf(query: string): string[] {
	const out: string[] = [];
	for (const term of query.toLowerCase().split(/\s+/)) {
		if (term && !out.includes(term)) out.push(term);
	}
	return out;
}

/**
 * Rank messages that contain every term (or, when nothing does, any term —
 * flagged `partial`). Score = distinct terms matched ×2 + occurrences (capped)
 * ×0.25 + user bonus + recency (1 for now, 0 at the window edge).
 */
export async function search(agentDir: string, opts: SearchOptions): Promise<SearchOutput> {
	const terms = termsOf(opts.query ?? "");
	const days = opts.days ?? DEFAULT_DAYS;
	const limit = Math.max(1, opts.limit ?? 8);
	const { indexes, stats } = await indexSessions(agentDir, { ...opts, days });
	if (terms.length === 0) return { results: [], partial: false, terms, stats };
	const cwdFilter = opts.cwd ? normalizePath(opts.cwd) : undefined;
	const pool = cwdFilter ? indexes.filter((i) => underCwd(i.cwd, cwdFilter)) : indexes;
	const now = opts.now ?? Date.now();
	const shortIds = shortIdMap(indexes.map((i) => i.sessionId));
	let results = collect(pool, terms, true, days, now, shortIds);
	let partial = false;
	if (results.length === 0 && terms.length > 1) {
		results = collect(pool, terms, false, days, now, shortIds);
		partial = results.length > 0;
	}
	results.sort((a, b) => b.score - a.score || b.ts - a.ts);
	return { results: results.slice(0, limit), partial, terms, stats };
}

function collect(indexes: SessionIndex[], terms: string[], all: boolean, days: number, now: number, shortIds: Map<string, string>): SearchResult[] {
	const out: SearchResult[] = [];
	const window = Math.max(1, days) * DAY_MS;
	for (const index of indexes) {
		const fallbackTs = Date.parse(index.timestamp) || index.mtimeMs;
		for (const m of index.messages) {
			const lower = m.text.toLowerCase();
			let matched = 0;
			let occurrences = 0;
			let first = -1;
			for (const term of terms) {
				const pos = lower.indexOf(term);
				if (pos < 0) {
					if (all) {
						matched = 0;
						break;
					}
					continue;
				}
				matched++;
				occurrences += countOccurrences(lower, term, pos, 8);
				if (first < 0 || pos < first) first = pos;
			}
			if (matched === 0) continue;
			const ts = m.ts || fallbackTs;
			const recency = Math.max(0, 1 - Math.max(0, now - ts) / window);
			const score = matched * 2 + Math.min(occurrences, 8) * 0.25 + (m.role === "user" ? USER_BONUS : 0) + recency;
			out.push({
				sessionId: index.sessionId,
				shortId: shortIds.get(index.sessionId) ?? index.sessionId,
				file: index.file,
				cwd: index.cwd,
				name: index.name,
				date: isoDate(ts),
				messageId: m.id,
				role: m.role,
				excerpt: excerptAt(m.text, first),
				score,
				ts,
			});
		}
	}
	return out;
}

function countOccurrences(haystack: string, needle: string, from: number, cap: number): number {
	let n = 0;
	let pos = from;
	while (pos >= 0 && n < cap) {
		n++;
		pos = haystack.indexOf(needle, pos + needle.length);
	}
	return n;
}

/** One line, ±EXCERPT_RADIUS chars around `pos`, ellipses where clipped. */
export function excerptAt(text: string, pos: number, radius = EXCERPT_RADIUS): string {
	const at = Math.min(Math.max(0, pos), text.length);
	const start = Math.max(0, at - radius);
	const end = Math.min(text.length, at + radius);
	const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/** Shortest of 8/13/18/full chars that is unique among `ids`. */
export function shortIdMap(ids: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const unique = [...new Set(ids)];
	for (const id of unique) {
		let chosen = id;
		for (const len of [8, 13, 18]) {
			const prefix = id.slice(0, len);
			if (unique.every((other) => other === id || !other.startsWith(prefix))) {
				chosen = prefix;
				break;
			}
		}
		out.set(id, chosen);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Read

/**
 * A page of one session: up to `limit` messages (default 8) within
 * `pageChars` (default 12000), starting 2 before `messageId` or at `offset`.
 * Returns undefined when no session matches; throws when the anchor message
 * is not in the session.
 */
export async function read(agentDir: string, opts: ReadOptions): Promise<ReadOutput | undefined> {
	const cacheDir = cacheDirFor(agentDir, opts);
	const info = await locate(agentDir, opts, cacheDir);
	if (!info) return undefined;
	const { index } = await loadIndex(info, cacheDir);
	const messages = index.messages;
	const fallbackTs = Date.parse(index.timestamp) || index.mtimeMs;
	let start = 0;
	if (opts.messageId) {
		const anchor = messages.findIndex((m) => m.id === opts.messageId);
		if (anchor < 0) throw new Error(`message ${opts.messageId} is not in session ${index.sessionId}`);
		start = Math.max(0, anchor - 2);
	} else if (typeof opts.offset === "number" && Number.isFinite(opts.offset)) {
		start = Math.min(Math.max(0, Math.floor(opts.offset)), messages.length);
	}
	const limit = Math.max(1, opts.limit ?? READ_LIMIT);
	const pageChars = Math.max(100, opts.pageChars ?? PAGE_CHARS);
	const lines: string[] = [];
	let used = 0;
	let i = start;
	for (; i < messages.length && lines.length < limit; i++) {
		const m = messages[i];
		let line = `[${m.role} ${isoMinute(m.ts || fallbackTs)}] ${m.text}`;
		if (lines.length > 0 && used + line.length + 1 > pageChars) break;
		if (line.length > pageChars) line = `${line.slice(0, pageChars - 1)}…`;
		lines.push(line);
		used += line.length + 1;
	}
	const more = i < messages.length;
	return {
		sessionId: index.sessionId,
		file: index.file,
		cwd: index.cwd,
		name: index.name,
		total: messages.length,
		start,
		count: lines.length,
		lines,
		text: lines.join("\n"),
		next_offset: more ? i : undefined,
		next_message_id: more ? messages[i].id : undefined,
	};
}

async function locate(agentDir: string, opts: ReadOptions, cacheDir: string): Promise<SessionFileInfo | undefined> {
	if (opts.file) {
		try {
			const st = statSync(opts.file);
			return { file: opts.file, size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			return undefined;
		}
	}
	const id = (opts.sessionId ?? "").trim().toLowerCase();
	if (!id) return undefined;
	const files = listSessionFiles(agentDir, { days: opts.days ?? 60, exclude: opts.exclude, now: opts.now });
	// Fast path: the uuid is in the file name.
	const byName = files.filter((f) => (sessionIdFromName(f.file) ?? "").toLowerCase().startsWith(id));
	if (byName.length > 0) return byName[0];
	// Slow path: compare header ids (cached indexes, so usually cheap).
	for (const f of files) {
		try {
			const { index } = await loadIndex(f, cacheDir);
			if (index.sessionId.toLowerCase().startsWith(id)) return f;
		} catch {
			// unreadable; keep looking
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Helpers

/** Absolute, forward slashes, no trailing slash; case-folded on Windows. */
export function normalizePath(p: string): string {
	let out = resolve(p).replace(/[\\/]+/g, "/");
	if (out.length > 1) out = out.replace(/\/+$/, "");
	return process.platform === "win32" ? out.toLowerCase() : out;
}

function underCwd(sessionCwd: string, filter: string): boolean {
	if (!sessionCwd) return false;
	const cwd = normalizePath(sessionCwd);
	return cwd === filter || cwd.startsWith(`${filter}/`);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local YYYY-MM-DD. */
export function isoDate(ts: number): string {
	if (!ts) return "unknown";
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local YYYY-MM-DD HH:mm. */
export function isoMinute(ts: number): string {
	if (!ts) return "?";
	const d = new Date(ts);
	return `${isoDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}
