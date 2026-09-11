/**
 * One JSON file of lessons per repo at `<agent-dir>/toolkit/learn/<repoKey>.json`:
 *
 *   {
 *     "repo": "github.com/acme/widgets",
 *     "lessons": [
 *       { "id": "1a2b3c4d", "text": "…", "createdAt": "…Z", "expiresAt": "…Z",
 *         "updatedAt": "…Z",                      // only after a replace
 *         "origin": { "provider": "anthropic", "model": "…", "thinkingLevel": "medium", "role": "main" } }
 *     ]
 *   }
 *
 * Lessons expire `ttlMs` after creation and are swept on load. Writes are
 * atomic (temp + rename) and serialised through a create-exclusive lock file
 * so a parent and its subagent children can save into the same file.
 * No pi imports.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../../core/paths.ts";

export interface LessonOrigin {
	provider: string | null;
	model: string | null;
	thinkingLevel: string | null;
	role: string | null;
}

export interface Lesson {
	id: string;
	text: string;
	createdAt: string;
	expiresAt: string;
	updatedAt?: string;
	origin?: LessonOrigin;
}

export interface LessonFile {
	repo: string;
	lessons: Lesson[];
}

export interface StoreOptions {
	dir: string;
	ttlMs: number;
	maxPerRepo: number;
	maxLessonChars: number;
	/** Clock override for tests. */
	now?: () => number;
}

export interface SaveInput {
	text: string;
	repoLabel: string;
	origin?: LessonOrigin;
	action?: "add" | "replace";
	/** Existing lesson texts to consolidate into this one (action "replace"). */
	replaces?: string[];
}

export interface SaveResult {
	/** "similar": not saved, `lesson` is the existing near-duplicate the caller may replace. */
	status: "added" | "duplicate" | "replaced" | "similar";
	lesson: Lesson;
	lessons: Lesson[];
	/** Lessons consolidated away by a replace. */
	removed: Lesson[];
	/** Oldest lessons evicted by the per-repo cap. */
	dropped: Lesson[];
}

export const DAY_MS = 86_400_000;
const PLACEHOLDER = /^(?:n\/?a|none|null|todo|tbd|nothing|no|yes|ok|unknown|-+|\.{2,}|…)[.!]?$/i;
const MIN_LESSON_CHARS = 12;

export function lessonFile(dir: string, repoKey: string): string {
	return join(dir, `${repoKey}.json`);
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Lowercase, single spaces, no trailing punctuation — the identity used for deduplication. */
export function normalizeText(text: string): string {
	return collapse(text.toLowerCase()).replace(/[.!,;:]+$/g, "").trim();
}

/** A reason the lesson cannot be stored, or undefined. */
export function validateLesson(text: unknown, maxChars: number): string | undefined {
	if (typeof text !== "string") return "lesson must be a string";
	const t = collapse(text);
	if (t.length < MIN_LESSON_CHARS || PLACEHOLDER.test(t)) {
		return "lesson is a placeholder; write one concrete reusable sentence, or skip the save";
	}
	if (t.length > maxChars) return `lesson is ${t.length} chars; max ${maxChars}`;
	return undefined;
}

function isLesson(value: unknown): value is Lesson {
	if (!value || typeof value !== "object") return false;
	const l = value as Record<string, unknown>;
	return (
		typeof l.id === "string" &&
		typeof l.text === "string" &&
		l.text.trim() !== "" &&
		Number.isFinite(Date.parse(String(l.createdAt))) &&
		Number.isFinite(Date.parse(String(l.expiresAt)))
	);
}

function readLessonFile(path: string, fallbackLabel: string): LessonFile {
	const raw = readJson<Partial<LessonFile>>(path, {});
	const repo = typeof raw.repo === "string" && raw.repo ? raw.repo : fallbackLabel;
	const lessons = Array.isArray(raw.lessons) ? raw.lessons.filter(isLesson) : [];
	return { repo, lessons };
}

export function sweep(lessons: Lesson[], now: number): { kept: Lesson[]; expired: Lesson[] } {
	const kept: Lesson[] = [];
	const expired: Lesson[] = [];
	for (const l of lessons) (Date.parse(l.expiresAt) <= now ? expired : kept).push(l);
	return { kept, expired };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const newId = (): string => randomBytes(4).toString("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Words that appear in almost every lesson and so prove nothing about two of
 * them being about the same thing. Small on purpose: a false "unrelated" costs
 * one corrected retry; a false "related" deletes a note.
 */
const STOP = new Set([
	"this", "that", "with", "from", "into", "only", "does", "could", "would", "should", "because", "before", "after", "through", "another",
	"when", "then", "than", "have", "will", "must", "never", "always", "also", "same", "such", "each", "every", "other", "there", "their",
	"path", "paths", "file", "files", "tool", "tools", "command", "commands", "error", "errors", "fail", "fails", "failed", "failure",
	"test", "tests", "verified", "verify", "workstation", "machine", "windows", "using", "used", "uses", "run", "runs", "running",
	"script", "scripts", "instead", "explicitly", "which", "where", "while", "these", "those", "without", "within", "already", "still",
]);

/** The subject terms of a lesson: words of four or more characters, minus the ones every lesson has. */
export function terms(text: string): Set<string> {
	return new Set((text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 4 && !STOP.has(t)));
}

/**
 * Whether `lesson` can be a revision of `target`: three shared subject terms,
 * or every term of the shorter one when it has fewer than three.
 *
 * Ported from the first auto-learn: on 2026-09-09 a permission-refusal note was
 * saved with the JAVA_HOME lesson in `replaces`, and the JAVA_HOME lesson was
 * gone. The two shared one term, "java".
 */
export function related(lesson: string, target: string): boolean {
	const a = terms(lesson);
	const b = terms(target);
	if (a.size === 0 || b.size === 0) return false;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared >= Math.min(3, a.size, b.size);
}

/**
 * Whether a new lesson is a near-duplicate of `target`: four shared subject
 * terms (all of them for shorter lessons), covering half of the shorter one.
 * On 2026-09-11 two grep `literal:true` lessons saved in parallel shared six
 * of twelve terms and both stayed.
 */
export function similar(lesson: string, target: string): boolean {
	const a = terms(lesson);
	const b = terms(target);
	const small = Math.min(a.size, b.size);
	if (small === 0) return false;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared >= Math.min(4, small) && shared / small >= 0.5;
}

function listText(lessons: Lesson[]): string {
	return lessons.map((l, i) => `${i + 1}. ${l.text}`).join("\n") || "(none)";
}

/**
 * Run `work` while holding `<path>.lock` (created exclusively, holding our pid).
 * Retries `attempts` × `delayMs`; a lock older than `staleMs` is assumed
 * orphaned by a killed writer and taken over.
 */
export async function withLock<T>(path: string, work: () => T | Promise<T>, attempts = 20, delayMs = 50, staleMs = 10_000): Promise<T> {
	ensureDir(dirname(path));
	const lock = `${path}.lock`;
	let fd: number | undefined;
	for (let i = 0; i < attempts && fd === undefined; i++) {
		try {
			fd = openSync(lock, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > staleMs) {
					unlinkSync(lock);
					continue;
				}
			} catch {
				/* vanished or unreadable: retry */
			}
			await sleep(delayMs);
		}
	}
	if (fd === undefined) throw new Error(`lesson store busy: ${lock} (remove it if its owner has exited)`);
	try {
		writeSync(fd, String(process.pid));
		return await work();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lock);
		} catch {
			/* already gone */
		}
	}
}

/** Single-attempt lock for best-effort housekeeping writes. */
function tryWriteLocked(path: string, data: LessonFile): boolean {
	const lock = `${path}.lock`;
	let fd: number;
	try {
		ensureDir(dirname(path));
		fd = openSync(lock, "wx");
	} catch {
		return false;
	}
	try {
		writeJsonAtomic(path, data);
		return true;
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lock);
		} catch {
			/* already gone */
		}
	}
}

/** Current lessons of a repo; expired ones are removed from the file when the lock is free. */
export function loadLessons(opts: StoreOptions, repoKey: string, repoLabel = repoKey): { repo: string; lessons: Lesson[]; expired: Lesson[] } {
	const path = lessonFile(opts.dir, repoKey);
	const now = opts.now?.() ?? Date.now();
	const file = readLessonFile(path, repoLabel);
	const { kept, expired } = sweep(file.lessons, now);
	if (expired.length > 0) tryWriteLocked(path, { repo: file.repo, lessons: kept });
	return { repo: file.repo, lessons: kept, expired };
}

/**
 * Add a lesson (default) or replace the listed ones with it. An add that
 * matches an existing lesson exactly is "duplicate", one that is `similar` to
 * one is "similar"; neither writes. Throws on
 * placeholder / oversize text, and on a replace whose targets are not all
 * present (the message lists the current lessons so the caller can retry).
 */
export async function saveLesson(opts: StoreOptions, repoKey: string, input: SaveInput): Promise<SaveResult> {
	const problem = validateLesson(input.text, opts.maxLessonChars);
	if (problem) throw new Error(problem);
	const text = collapse(input.text);
	const path = lessonFile(opts.dir, repoKey);
	return withLock(path, () => {
		const now = opts.now?.() ?? Date.now();
		const file = readLessonFile(path, input.repoLabel);
		const { kept, expired } = sweep(file.lessons, now);
		const repo = input.repoLabel || file.repo;
		let lessons = kept;
		const norm = normalizeText(text);
		const removed: Lesson[] = [];
		let createdAt = now;
		let updatedAt: number | undefined;

		if ((input.action ?? "add") === "replace") {
			const targets = (input.replaces ?? []).map(normalizeText).filter(Boolean);
			if (targets.length === 0) {
				throw new Error(`action "replace" needs replaces: the exact text of the lesson(s) to replace. Current lessons:\n${listText(lessons)}`);
			}
			const missing = targets.filter((t) => !lessons.some((l) => normalizeText(l.text) === t));
			if (missing.length > 0) {
				throw new Error(`replaces not found: ${missing.map((m) => JSON.stringify(m)).join(", ")}. Current lessons:\n${listText(lessons)}`);
			}
			const unrelated = lessons.find((l) => targets.includes(normalizeText(l.text)) && !related(text, l.text));
			if (unrelated) {
				const quoted = unrelated.text.length > 80 ? `${unrelated.text.slice(0, 79)}…` : unrelated.text;
				throw new Error(`replaces "${quoted}" shares no subject with the new lesson, so it would be deleted, not revised; nothing was saved. Replace only lessons this one corrects or merges; save anything else with action "add".`);
			}
			for (const l of lessons) {
				const n = normalizeText(l.text);
				if (targets.includes(n) || n === norm) removed.push(l);
			}
			lessons = lessons.filter((l) => !removed.includes(l));
			createdAt = Math.min(now, ...removed.map((l) => Date.parse(l.createdAt)));
			updatedAt = now;
		} else {
			const existing = lessons.find((l) => normalizeText(l.text) === norm);
			const near = existing ? undefined : lessons.find((l) => similar(text, l.text));
			if (existing || near) {
				if (expired.length > 0) writeJsonAtomic(path, { repo, lessons });
				return { status: existing ? "duplicate" : "similar", lesson: (existing ?? near) as Lesson, lessons, removed: [], dropped: [] };
			}
		}

		const lesson: Lesson = {
			id: newId(),
			text,
			createdAt: iso(createdAt),
			expiresAt: iso(createdAt + opts.ttlMs),
			...(updatedAt !== undefined ? { updatedAt: iso(updatedAt) } : {}),
			...(input.origin ? { origin: input.origin } : {}),
		};
		lessons = [...lessons, lesson].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
		const dropped: Lesson[] = [];
		while (lessons.length > opts.maxPerRepo) dropped.push(lessons.shift() as Lesson);
		writeJsonAtomic(path, { repo, lessons });
		return { status: removed.length > 0 ? "replaced" : "added", lesson, lessons, removed, dropped };
	});
}

/** Remove the lesson at `index` (0-based, in load order). */
export async function forgetLesson(opts: StoreOptions, repoKey: string, index: number, repoLabel = repoKey): Promise<{ removed?: Lesson; lessons: Lesson[] }> {
	const path = lessonFile(opts.dir, repoKey);
	return withLock(path, () => {
		const now = opts.now?.() ?? Date.now();
		const file = readLessonFile(path, repoLabel);
		const { kept } = sweep(file.lessons, now);
		const removed = kept[index];
		const lessons = kept.filter((_, i) => i !== index);
		if (removed || kept.length !== file.lessons.length) writeJsonAtomic(path, { repo: file.repo, lessons });
		return { removed, lessons };
	});
}

/** "3d 4h", "5h", or "expired". */
export function formatExpiry(expiresAt: string, now = Date.now()): string {
	const ms = Date.parse(expiresAt) - now;
	if (!Number.isFinite(ms) || ms <= 0) return "expired";
	const days = Math.floor(ms / DAY_MS);
	const hours = Math.floor((ms % DAY_MS) / 3_600_000);
	return days > 0 ? `${days}d ${hours}h` : `${Math.max(hours, 1)}h`;
}
