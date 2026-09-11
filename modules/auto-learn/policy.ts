/**
 * Which tool results count as a failure worth a lesson, and the short
 * note appended to their stored result. No pi imports, so tests run under bare
 * node.
 *
 * A failure is: `isError`, a non-zero shell exit, or a short result carrying an
 * unmistakable error phrase (ENOENT, command not found, …). Not a failure: an
 * expected matcher exit (grep/rg exit 1 = no match, diff/cmp exit 1, `test`/`[`,
 * `which` in a pipeline), a background job still running, a timeout, our own
 * `learn` tool, or a file tool given a path that does not exist (a wrong guess:
 * on 2026-09-11 two of those became "classes live under src/" lessons).
 */

export interface ResultLike {
	toolName: string;
	toolCallId: string;
	input?: Record<string, unknown>;
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

export type FailureKind = "error" | "refusal";

export interface Failure {
	/** Session-local short id, `L<n>`. */
	id: string;
	kind: FailureKind;
	toolName: string;
	toolCallId: string;
	/** The command / path / query that failed, first 200 chars. */
	head: string;
	/** First 300 chars of the error text. */
	error: string;
	repoKey: string;
	/** Set once `learn` saved (or deduplicated) a lesson for it. */
	handled: boolean;
}

/** Our own tools never trigger learning. */
export const OWN_TOOLS = new Set(["learn", "auto_learn"]);

/** Commands whose exit status 1 is a finding, not a fault. */
const MATCHERS = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "test", "["]);
/** Probes whose exit 1 means "not there" — expected when part of a pipeline or chain. */
const PROBES = new Set(["which", "type", "command"]);
/** Leading words that are not the command: `sudo`, `rtk proxy`, `time`, … */
const WRAPPERS = new Set(["sudo", "rtk", "proxy", "time", "nice", "exec", "env"]);

const EXIT_STATUS = /(?:^|\n)Command exited with code (\d+)\s*$/;
const TRANSIENT = /Command timed out after \d+ seconds|\[killed: timeout\]|^Operation aborted$/m;
const REFUSAL = /blocked by permissions|\[permissions\]/i;
const ERROR_SIGNALS = [
	/command not found/i,
	/No such file or directory/,
	/\bENOENT\b/,
	/Permission denied/,
	/is not recognized as an internal or external command/i,
	/oldText[^\n]{0,60}not found|not found[^\n]{0,60}oldText|could not find[^\n]{0,60}oldText/i,
	/^(?:Error: )?(?:File|Path|Directory) (?:not found|does not exist)/im,
];
/** Error phrases only count in short results; a listing that mentions them is not a failure. */
const SIGNAL_MAX_CHARS = 600;
/** Tools whose not-found error only means the path was guessed wrong. */
const FILE_TOOLS = new Set(["read", "edit", "write", "ls", "find", "grep"]);
const NOT_FOUND = /\bENOENT\b|No such file or directory|^(?:Error: )?(?:File|Path|Directory) (?:not found|does not exist)/im;

export function textOf(result: ResultLike): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** `details.exitCode` when a module supplies it, else pi's trailing "Command exited with code N". */
export function exitCodeOf(result: ResultLike, text = textOf(result)): number | undefined {
	const details = result.details as { exitCode?: unknown } | undefined;
	if (details && typeof details.exitCode === "number") return details.exitCode;
	const m = EXIT_STATUS.exec(text);
	return m ? Number.parseInt(m[1], 10) : undefined;
}

/** Split a shell line at unquoted `|`, `||`, `&&`, `;` and newlines. */
function segments(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote === '"') cur += command[++i] ?? "";
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "\\") {
			cur += ch + (command[++i] ?? "");
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "||" || two === "&&") {
			out.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (ch === "|" || ch === ";" || ch === "\n") {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** The program a segment runs, minus env assignments, wrappers, directories and `.exe`. */
function commandName(segment: string): string | undefined {
	const words = segment.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < words.length) {
		const w = words[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(w)) {
			i++;
			continue;
		}
		if (w === "timeout" && /^\d/.test(words[i + 1] ?? "")) {
			i += 2;
			continue;
		}
		break;
	}
	const raw = words[i];
	if (!raw) return undefined;
	return raw.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** The program of every segment of a shell line, in order. */
export function commandNames(command: string): string[] {
	return segments(command.replace(/\r/g, ""))
		.map(commandName)
		.filter((n): n is string => n !== undefined);
}

/** The command whose status the shell reported: the last segment. */
export function finalCommand(command: string): { name: string; chained: boolean } | undefined {
	const names = commandNames(command);
	if (names.length === 0) return undefined;
	return { name: names[names.length - 1], chained: names.length > 1 };
}

/** Exit 1 from a matcher, or from a pipeline/chain containing a probe, is the answer, not a failure. */
export function expectedExit(command: string, code: number): boolean {
	if (code !== 1) return false;
	const names = commandNames(command);
	if (names.length === 0) return false;
	if (MATCHERS.has(names[names.length - 1])) return true;
	return names.length > 1 && names.some((n) => PROBES.has(n));
}

function hasErrorSignal(text: string): boolean {
	if (!text || text.length > SIGNAL_MAX_CHARS) return false;
	return ERROR_SIGNALS.some((re) => re.test(text));
}

/** The failure kind of a tool result, or undefined when it is not a failure worth a lesson. */
export function classify(result: ResultLike): FailureKind | undefined {
	if (OWN_TOOLS.has(result.toolName)) return undefined;
	const details = result.details as { keepalive?: { running?: unknown } } | undefined;
	if (details?.keepalive?.running === true) return undefined;
	const text = textOf(result);
	if (TRANSIENT.test(text)) return undefined;
	if (FILE_TOOLS.has(result.toolName) && NOT_FOUND.test(text.slice(0, SIGNAL_MAX_CHARS))) return undefined;

	let failed = result.isError === true;
	if (result.toolName === "bash" || result.toolName === "powershell") {
		const code = exitCodeOf(result, text);
		if (code !== undefined && code !== 0) {
			const command = typeof result.input?.command === "string" ? result.input.command : "";
			if (expectedExit(command, code)) return undefined;
			failed = true;
		}
	}
	if (!failed && hasErrorSignal(text)) failed = true;
	if (!failed) return undefined;
	return REFUSAL.test(text) ? "refusal" : "error";
}

/** The command / path / pattern of a call, one line, at most 200 chars. */
export function describeCall(toolName: string, input: Record<string, unknown> | undefined): string {
	if (!input) return toolName;
	let s = ["command", "path", "pattern", "query", "url"]
		.map((k) => input[k])
		.filter((v): v is string => typeof v === "string" && v.length > 0)
		.join(" ");
	if (!s) {
		try {
			s = JSON.stringify(input);
		} catch {
			s = toolName;
		}
	}
	return s.replace(/\s+/g, " ").slice(0, 200);
}

/** The note appended to a failure's stored tool result. Under 60 words. */
export function guidance(failure: Failure): string {
	const call = `learn({failureId:"${failure.id}", lesson:"…"})`;
	if (failure.kind === "refusal") {
		return `[auto-learn ${failure.id}] Permission refusal: stop, do not retry it or route around it through another tool, shell or path. You may record exactly what was blocked and its scope, nothing broader: ${call}.`;
	}
	return `[auto-learn ${failure.id}] Once you have a verified fix (a retry that happens to pass is not proof), save the cause and what to do next time — tool usage, command syntax, environment, test setup; not where code lives: ${call}. Replace a related lesson rather than adding a near-duplicate. Skip transient failures, typos and expected results.`;
}
