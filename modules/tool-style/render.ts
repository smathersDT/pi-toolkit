/**
 * What each built-in tool shows inside its frame: the head lines under the
 * title (command, path, pattern) and the body under the separator (output,
 * diff, verdict). Pure functions over the tool's args and result so the tests
 * can exercise every shape without pi's TUI; only core/frame.ts and node
 * built-ins are imported.
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type BodyOptions, COLLAPSED_LINES, type FrameTheme, textOf, toLines } from "../../core/frame.ts";
import type { BuiltinToolName } from "../../core/kit.ts";
import { plural } from "../../core/text.ts";

export type ToolResultLike = { content?: Array<{ type: string; text?: string }>; details?: unknown };

export interface BodyInput {
	result: ToolResultLike;
	args: unknown;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
}

/** Body options for a FrameBottom plus muted footer lines (truncation notes). */
export interface ToolBody {
	body: BodyOptions;
	footer: string[];
}

type Args = Record<string, unknown>;

function argsOf(args: unknown): Args {
	return args && typeof args === "object" ? (args as Args) : {};
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toPosix(p: string): string {
	return sep === "/" ? p : p.split(sep).join("/");
}

/** `abs` relative to `base` when inside it ("." for base itself), else undefined. */
function under(base: string, abs: string): string | undefined {
	const rel = relative(base, abs);
	if (rel === "") return ".";
	if (/^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) return undefined;
	return toPosix(rel);
}

/** A path relative to cwd when inside it, `~/…` when under home, otherwise as given. */
export function displayPath(raw: unknown, cwd: string): string {
	const path = str(raw);
	if (!path) return "";
	let abs: string;
	try {
		abs = isAbsolute(path) ? path : resolve(cwd, path);
	} catch {
		return path;
	}
	const fromCwd = under(cwd, abs);
	if (fromCwd !== undefined) return fromCwd;
	const home = homedir();
	if (home) {
		const fromHome = under(home, abs);
		if (fromHome === ".") return "~";
		if (fromHome !== undefined) return `~/${fromHome}`;
	}
	return path;
}

/** Lines in a write's content: 0 for empty, a trailing newline does not add one. */
export function countLines(content: string): number {
	if (content === "") return 0;
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/** `:offset-end` for a ranged read, `:offset` when open-ended, "" for a whole file. */
function readRange(a: Args): string {
	const offset = typeof a.offset === "number" ? a.offset : undefined;
	const limit = typeof a.limit === "number" ? a.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

/** The head lines under the title: what the tool was asked to do. */
export function headLines(tool: BuiltinToolName, args: unknown, cwd: string): string[] {
	const a = argsOf(args);
	switch (tool) {
		case "bash": {
			const lines = toLines(str(a.command));
			return lines.length > 0 ? lines : ["…"];
		}
		case "read":
			return [`${displayPath(a.path, cwd) || "…"}${readRange(a)}`];
		case "edit": {
			const edits = Array.isArray(a.edits) ? a.edits.length : 0;
			return [`${displayPath(a.path, cwd) || "…"} · ${plural(edits, "edit")}`];
		}
		case "write":
			return [`${displayPath(a.path, cwd) || "…"} · ${plural(countLines(str(a.content)), "line")}`];
		case "grep": {
			const parts = [str(a.pattern) || "…"];
			const path = displayPath(a.path, cwd);
			if (path) parts.push(path);
			const glob = str(a.glob);
			if (glob) parts.push(glob);
			return [parts.join(" · ")];
		}
		case "find": {
			const parts = [str(a.pattern) || "…"];
			const path = displayPath(a.path, cwd);
			if (path) parts.push(path);
			return [parts.join(" · ")];
		}
		case "ls":
			return [displayPath(a.path, cwd) || "."];
		default:
			return [];
	}
}

/** auto-learn appends model-facing notes and lesson blocks to results; they have their own transcript rows. */
const MODEL_NOTES = /(?:^|\n\n)\[auto-learn[ \]]/;

export function stripModelNotes(text: string): string {
	const m = MODEL_NOTES.exec(text);
	return m ? text.slice(0, m.index) : text;
}

/** pi appends a model-facing footer to reads: "[Showing lines …]" / "[N more lines …]". Cut it. */
export function stripReadFooter(text: string): string {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("]")) return text;
	const at = trimmed.lastIndexOf("\n\n[");
	return at === -1 ? text : trimmed.slice(0, at).trimEnd();
}

/** A read of an image: an image block, or the summary text pi emits for one. */
export function isImageResult(result: ToolResultLike, text: string): boolean {
	return (result.content ?? []).some((c) => c.type === "image") || text.startsWith("Read image file");
}

/** Colour a pi edit diff (`+12 text`, `-12 text`, ` 12 text`). Returns pre-coloured lines. */
export function diffLines(diff: string, theme: FrameTheme): string[] {
	return toLines(diff).map((line) => {
		const text = line.replace(/\t/g, "  ");
		if (text.startsWith("+")) return theme.fg("success", text);
		if (text.startsWith("-")) return theme.fg("error", text);
		return theme.fg("muted", text);
	});
}

type Truncation = { truncated?: boolean; outputLines?: number; totalLines?: number };

function truncationNote(details: Args | undefined, what: string): string[] {
	const t = details?.truncation as Truncation | undefined;
	if (!t?.truncated) return [];
	return [`truncated: ${t.outputLines ?? "?"} of ${t.totalLines ?? "?"} ${what}`];
}

function limitNote(n: unknown, singular: string, pluralForm = `${singular}s`): string[] {
	return typeof n === "number" && n > 0 ? [`stopped at ${n} ${n === 1 ? singular : pluralForm}`] : [];
}

/** Plain output lines, coloured by the frame. */
function plain(lines: string[], expanded: boolean, tail = false): BodyOptions {
	return { lines, expanded, tail, maxLines: COLLAPSED_LINES, color: "toolOutput" };
}

/** Lines that already carry their colour. */
function styled(lines: string[], expanded: boolean, tail = false): BodyOptions {
	return { lines, expanded, tail, maxLines: COLLAPSED_LINES, color: "" };
}

function textOrEmpty(lines: string[], expanded: boolean, theme: FrameTheme, tail = false): BodyOptions {
	return lines.length > 0 ? plain(lines, expanded, tail) : styled([theme.fg("muted", "(no output)")], expanded);
}

/** The body of a tool result: lines for the FrameBottom and any footer notes. */
export function toolBody(tool: BuiltinToolName, input: BodyInput, theme: FrameTheme): ToolBody {
	const { result, expanded, isError } = input;
	const text = stripModelNotes(textOf(result));
	if (isError) {
		const lines = toLines(text);
		const shown = (lines.length > 0 ? lines : ["Error"]).map((l) => theme.fg("error", l.replace(/\t/g, "  ")));
		return { body: styled(shown, expanded, tool === "bash"), footer: [] };
	}
	const details = result.details && typeof result.details === "object" ? (result.details as Args) : undefined;
	switch (tool) {
		case "bash": {
			// The verdict is at the end, so a collapsed bash frame shows the tail; partial
			// results take the same path, so output scrolls while the command runs.
			const footer = truncationNote(details, "lines");
			const full = details?.fullOutputPath;
			if (typeof full === "string" && full) footer.push(`full output: ${full}`);
			return { body: textOrEmpty(toLines(text), expanded, theme, true), footer };
		}
		case "read": {
			if (isImageResult(result, text)) return { body: plain([toLines(text)[0] ?? "Read image"], expanded), footer: [] };
			return { body: textOrEmpty(toLines(stripReadFooter(text)), expanded, theme), footer: truncationNote(details, "lines") };
		}
		case "edit": {
			const diff = details?.diff;
			if (typeof diff === "string" && diff.trim()) return { body: styled(diffLines(diff, theme), expanded), footer: [] };
			return { body: textOrEmpty(toLines(text), expanded, theme), footer: [] };
		}
		case "write": {
			const a = argsOf(input.args);
			return { body: plain([`Wrote ${plural(countLines(str(a.content)), "line")}`], expanded), footer: [] };
		}
		case "grep": {
			const footer = [...limitNote(details?.matchLimitReached, "match", "matches"), ...truncationNote(details, "lines")];
			if (details?.linesTruncated) footer.push("some lines shortened");
			return { body: textOrEmpty(toLines(text), expanded, theme), footer };
		}
		case "find":
			return {
				body: textOrEmpty(toLines(text), expanded, theme),
				footer: [...limitNote(details?.resultLimitReached, "result"), ...truncationNote(details, "lines")],
			};
		case "ls":
			return {
				body: textOrEmpty(toLines(text), expanded, theme),
				footer: [...limitNote(details?.entryLimitReached, "entry", "entries"), ...truncationNote(details, "lines")],
			};
		default:
			return { body: textOrEmpty(toLines(text), expanded, theme), footer: [] };
	}
}

const EXIT_LINE = /^Command exited with code (\d+)$/;

/** The head shown on a finished row's summary line: the first head line, "…" when the command goes on. */
export function summaryHead(tool: BuiltinToolName, args: unknown, cwd: string): string {
	const head = headLines(tool, args, cwd);
	return head.length > 1 ? `${head[0].trim()} …` : (head[0] ?? "");
}

/** What a finished row's summary line says after the head: counts, the verdict line, or the error. */
export function summaryStats(tool: BuiltinToolName, input: Pick<BodyInput, "result" | "args" | "isError">): string[] {
	const { result, isError } = input;
	const text = stripModelNotes(textOf(result));
	const lines = toLines(text)
		.map((l) => l.trim())
		.filter(Boolean);
	const details = result.details && typeof result.details === "object" ? (result.details as Args) : undefined;
	if (isError) {
		const exit = lines.map((l) => EXIT_LINE.exec(l)?.[1]).find(Boolean);
		const words = lines.filter((l) => !EXIT_LINE.test(l));
		// bash ends with the reason; everything else leads with it.
		const reason = (tool === "bash" ? words[words.length - 1] : words[0]) ?? "error";
		return exit ? [`exit ${exit}`, reason] : [reason];
	}
	switch (tool) {
		case "bash": {
			if (lines.length === 0) return ["no output"];
			if (lines.length === 1) return [lines[0]];
			return [plural(lines.length, "line"), lines[lines.length - 1], ...truncationNote(details, "lines")];
		}
		case "read": {
			if (isImageResult(result, text)) return [lines[0] ?? "image"];
			return [plural(toLines(stripReadFooter(text)).length, "line"), ...truncationNote(details, "lines")];
		}
		case "edit": {
			const diff = typeof details?.diff === "string" ? toLines(details.diff) : [];
			if (diff.length === 0) return lines.slice(0, 1);
			const added = diff.filter((l) => l.startsWith("+")).length;
			const removed = diff.filter((l) => l.startsWith("-")).length;
			return [`+${added} −${removed}`];
		}
		case "write":
			return [];
		case "grep": {
			if (lines.length === 1 && !/:\d+: /.test(lines[0])) return [lines[0]];
			const matches = lines.filter((l) => /^.+?:\d+: /.test(l)).length;
			return [matches > 0 ? plural(matches, "match") : plural(lines.length, "line"), ...limitNote(details?.matchLimitReached, "match", "matches"), ...truncationNote(details, "lines")];
		}
		case "find":
			if (lines.length === 1 && /^No files/.test(lines[0])) return [lines[0]];
			return [plural(lines.length, "result"), ...limitNote(details?.resultLimitReached, "result"), ...truncationNote(details, "lines")];
		case "ls":
			if (lines.length === 1 && lines[0] === "(empty directory)") return ["empty"];
			return [lines.length === 1 ? "1 entry" : `${lines.length} entries`, ...limitNote(details?.entryLimitReached, "entry", "entries"), ...truncationNote(details, "lines")];
		default:
			return lines.length > 0 ? [plural(lines.length, "line")] : [];
	}
}
