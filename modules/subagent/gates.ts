/**
 * Role gates a child enforces on its own tool calls. pi-free.
 *
 *   git     bash may run only read-only git subcommands (plus `cd …` and
 *           read-only pipe filters such as head/grep)
 *   test    bash may run only test runners and checks (npm test, pytest,
 *           php -l, node --check, git diff --check, any pwsh/powershell
 *           command, …), optionally after `cd …`
 *   worker  edit/write only inside `ownedFiles`; bash writes it can detect
 *           (`>`/`>>` redirects, sed -i, mv/rm/cp/tee) must target owned
 *           files or the temp dir
 *
 * git and test also let through the role's `allow` patterns (regexes from
 * subagents.json, matched against each command of a chain).
 */
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

export interface GateBlock {
	block: true;
	reason: string;
}

export interface GateContext {
	role: string | undefined;
	ownedFiles: string[];
	cwd: string;
	/** Defaults to os.tmpdir(). */
	tmpDir?: string;
	/** Extra commands the git/test gate lets through (the role's `allow`). */
	allow?: RegExp[];
}

/** Filters a read-only command may pipe into. */
const PIPE_FILTERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "wc", "sort", "uniq", "cat", "cut", "awk", "tr", "less", "more", "column", "nl", "tee"]);

/** git subcommands that do not change the repository or the working tree. */
const GIT_READONLY = new Set([
	"log", "blame", "show", "diff", "status", "shortlog", "rev-parse", "rev-list", "describe", "ls-files", "ls-tree", "cat-file", "grep", "name-rev", "reflog",
	"whatchanged", "count-objects", "for-each-ref", "merge-base", "cherry", "diff-tree", "diff-index", "show-ref", "show-branch", "var", "version", "help",
	"check-ignore", "ls-remote", "fetch", "annotate", "range-diff", "log-tree",
]);

const TEST_RUNNERS: RegExp[] = [
	/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)(:[\w-]+)?(\s|$)/,
	/^npx\s+(vitest|jest|mocha|ava|tap)(\s|$)/,
	/^(vitest|jest|mocha|ava|tap)(\s|$)/,
	/^(python3?\s+-m\s+)?pytest(\s|$)/,
	/^go\s+test(\s|$)/,
	/^cargo\s+(nextest\s+run|test)(\s|$)/,
	/^(mvn|mvnw|\.\/mvnw)\s+(.*\s)?(test|verify)(\s|$)/,
	/^(\.[\\/])?gradlew?(\.bat)?\s+(.*\s)?test(\s|$)/,
	/^php\s+artisan\s+test(\s|$)/,
	/^(\.\/)?(vendor\/bin\/)?phpunit(\s|$)/,
	/^composer\s+(run\s+)?test(\s|$)/,
	/^node\s+--test(\s|$)/,
	/^dotnet\s+test(\s|$)/,
	/^(pnpm|yarn|bun)\s+(vitest|jest|mocha)(\s|$)/,
	// Repo scripts on Windows (tests/run.ps1): every PowerShell invocation.
	/^(pwsh|powershell)(\.exe)?(\s|$)/i,
	// Checks that change nothing.
	/^node\s+(--check|-c)(\s|$)/,
	/^php\s+(-l|--syntax-check)(\s|$)/,
	/^php\s+(\.\/)?vendor\/bin\/phpunit(\s|$)/,
	/^git\s+(-C\s+\S+\s+)?diff\s+(.*\s)?--check(\s|$)/,
	/^(npx\s+|pnpm\s+(exec\s+)?|yarn\s+)?tsc\s+(.*\s)?--noEmit(\s|$)/,
];

/** Split at separators outside quotes; `sepAt` returns the separator's length at i, or 0. */
function splitUnquoted(text: string, sepAt: (text: string, i: number) => number): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			cur += ch + text[++i];
			continue;
		}
		const len = sepAt(text, i);
		if (len > 0) {
			out.push(cur);
			cur = "";
			i += len - 1;
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Split on `&&`, `||`, `;` and newlines outside quotes; each piece is one command (possibly a pipeline). */
export function splitShellSegments(command: string): string[] {
	return splitUnquoted(command.replace(/\r\n?/g, "\n"), (t, i) => {
		const two = t.slice(i, i + 2);
		if (two === "&&" || two === "||") return 2;
		return t[i] === ";" || t[i] === "\n" ? 1 : 0;
	});
}

function pipeParts(segment: string): string[] {
	return splitUnquoted(segment, (t, i) => (t[i] === "|" ? 1 : 0));
}

const allowed = (part: string, allow: RegExp[] | undefined): boolean => !!allow?.some((re) => re.test(part));

/** Drop leading `VAR=value` assignments. */
function stripEnvPrefix(part: string): string {
	return part.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

function tokens(part: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null = re.exec(part);
	while (m) {
		out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/^@/, ""));
		m = re.exec(part);
	}
	return out;
}

function isCd(part: string): boolean {
	return /^cd(\s|$)/.test(part);
}

function isPipeFilter(part: string): boolean {
	const cmd = tokens(stripEnvPrefix(part))[0] ?? "";
	if (!PIPE_FILTERS.has(cmd)) return false;
	// `sed -i`/`tee file` in a pipe would write; sed is not in the list, tee is checked by the worker gate.
	return true;
}

function gitReadonly(part: string): boolean {
	const t = tokens(stripEnvPrefix(part));
	if (t[0] !== "git") return false;
	let i = 1;
	// global options: -C <dir>, -c k=v, --no-pager, --git-dir=…
	while (i < t.length && t[i].startsWith("-")) {
		if (t[i] === "-C" || t[i] === "-c") i += 2;
		else i += 1;
	}
	const sub = t[i];
	if (!sub) return false;
	const rest = t.slice(i + 1);
	if (GIT_READONLY.has(sub)) return true;
	if (sub === "branch" || sub === "tag" || sub === "stash" || sub === "remote" || sub === "worktree" || sub === "config" || sub === "submodule" || sub === "notes") {
		return listOnly(sub, rest);
	}
	return false;
}

/** Sub-commands that read by default but write with the wrong arguments. */
function listOnly(sub: string, rest: string[]): boolean {
	const positional = rest.filter((a) => !a.startsWith("-"));
	switch (sub) {
		case "branch":
			return rest.every((a) => /^(-a|-r|-l|-v|-vv|--list|--all|--remotes|--verbose|--contains=?.*|--merged=?.*|--no-merged=?.*|--points-at=?.*|--sort=.*|--format=.*|--color.*|--no-color)$/.test(a) || (!a.startsWith("-") && rest.some((f) => /^(--contains|--merged|--no-merged|--points-at|-l|--list)$/.test(f))));
		case "tag":
			return positional.length === 0 || rest.some((a) => /^(-l|--list|-n\d*|--contains|--points-at|--merged|--no-merged)$/.test(a));
		case "stash":
			return positional[0] === "list" || positional[0] === "show";
		case "remote":
			return positional.length === 0 || positional[0] === "show" || positional[0] === "get-url" || rest.includes("-v");
		case "worktree":
			return positional[0] === "list";
		case "config":
			return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
		case "submodule":
			return positional.length === 0 || positional[0] === "status";
		case "notes":
			return positional.length === 0 || positional[0] === "list" || positional[0] === "show";
		default:
			return false;
	}
}

/** Every segment is a read-only git command (or `cd`, or an `allow` match), pipes only into filters. */
export function isGitCommand(command: string, allow?: RegExp[]): boolean {
	const segments = splitShellSegments(command);
	if (segments.length === 0) return false;
	let sawGit = false;
	for (const segment of segments) {
		const parts = pipeParts(segment);
		if (parts.length === 0) return false;
		const first = stripEnvPrefix(parts[0]);
		if (isCd(first)) {
			if (parts.length > 1) return false;
			continue;
		}
		if (!gitReadonly(first) && !allowed(first, allow)) return false;
		sawGit = true;
		for (const rest of parts.slice(1)) if (!isPipeFilter(rest)) return false;
	}
	return sawGit;
}

export function isTestRunner(part: string, allow?: RegExp[]): boolean {
	const p = stripEnvPrefix(part).replace(/^@/, "");
	return TEST_RUNNERS.some((re) => re.test(p)) || allowed(p, allow);
}

/** Every segment is a test runner or check (or `cd`), pipes only into filters. */
export function isTestCommand(command: string, allow?: RegExp[]): boolean {
	const segments = splitShellSegments(command);
	if (segments.length === 0) return false;
	let sawRunner = false;
	for (const segment of segments) {
		const parts = pipeParts(segment);
		if (parts.length === 0) return false;
		const first = stripEnvPrefix(parts[0]);
		if (isCd(first)) {
			if (parts.length > 1) return false;
			continue;
		}
		if (!isTestRunner(first, allow)) return false;
		sawRunner = true;
		for (const rest of parts.slice(1)) if (!isPipeFilter(rest)) return false;
	}
	return sawRunner;
}

/** The role's `allow` sources (an array, or its JSON from the environment) as regexes; invalid ones are skipped. */
export function parseAllow(raw: unknown): RegExp[] {
	let list = raw;
	if (typeof raw === "string") {
		try {
			list = JSON.parse(raw);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(list)) return [];
	const out: RegExp[] = [];
	for (const source of list) {
		if (typeof source !== "string" || !source.trim()) continue;
		try {
			out.push(new RegExp(source));
		} catch {
			/* not a regex: skip */
		}
	}
	return out;
}

function normalizePath(p: string): string {
	let n = resolve(p).replace(/[\\/]+$/, "");
	if (process.platform === "win32") n = n.toLowerCase();
	return n;
}

/** Is `path` one of the owned files, inside an owned directory, or inside the temp dir? */
export function isOwnedPath(path: string, ctx: GateContext): boolean {
	const clean = path.replace(/^@/, "").trim();
	if (!clean) return false;
	const abs = normalizePath(resolve(ctx.cwd, clean));
	const tmp = normalizePath(ctx.tmpDir ?? tmpdir());
	if (abs === tmp || abs.startsWith(tmp + sep)) return true;
	for (const owned of ctx.ownedFiles) {
		const o = normalizePath(resolve(ctx.cwd, owned.replace(/^@/, "").trim()));
		if (abs === o || abs.startsWith(o + sep)) return true;
	}
	return false;
}

/** Paths a shell command writes to, as far as a regex can tell. */
export function shellWriteTargets(command: string): string[] {
	const targets: string[] = [];
	const redirect = /(?:^|[^&<>])(\d?)>{1,2}\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+)/g;
	let m: RegExpExecArray | null = redirect.exec(command);
	while (m) {
		const raw = m[2].replace(/^["']|["']$/g, "");
		if (!raw.startsWith("&") && raw !== "/dev/null" && raw.toUpperCase() !== "NUL") targets.push(raw);
		m = redirect.exec(command);
	}
	for (const segment of splitShellSegments(command)) {
		for (const part of pipeParts(segment)) {
			const t = tokens(stripEnvPrefix(part));
			const cmd = t[0];
			if (!cmd) continue;
			if (cmd === "sed") {
				const inPlace = t.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"));
				if (!inPlace) continue;
				const files: string[] = [];
				let sawScriptFlag = false;
				for (let i = 1; i < t.length; i++) {
					const a = t[i];
					if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
						sawScriptFlag = true;
						i++;
						continue;
					}
					if (a.startsWith("-")) continue;
					files.push(a);
				}
				targets.push(...(sawScriptFlag ? files : files.slice(1)));
			} else if (cmd === "rm" || cmd === "mv" || cmd === "truncate" || cmd === "tee") {
				targets.push(...t.slice(1).filter((a) => !a.startsWith("-")));
			} else if (cmd === "cp") {
				const positional = t.slice(1).filter((a) => !a.startsWith("-"));
				if (positional.length >= 2) targets.push(positional[positional.length - 1]);
			}
		}
	}
	return targets;
}

function inputString(input: unknown, key: string): string {
	const v = (input as Record<string, unknown> | undefined)?.[key];
	return typeof v === "string" ? v : "";
}

/** The worker gate: edits and detectable shell writes must stay inside ownedFiles. */
export function checkWorkerGate(toolName: string, input: unknown, ctx: GateContext): GateBlock | undefined {
	const owned = ctx.ownedFiles.length ? ctx.ownedFiles.join(", ") : "(none)";
	if (toolName === "edit" || toolName === "write") {
		const path = inputString(input, "path");
		if (!isOwnedPath(path, ctx)) return { block: true, reason: `worker may only edit its owned files (${owned}); ${path || "no path"} is not one of them` };
		return undefined;
	}
	if (toolName === "bash") {
		for (const target of shellWriteTargets(inputString(input, "command"))) {
			if (!isOwnedPath(target, ctx)) return { block: true, reason: `shell write to ${target} is outside the owned files (${owned}); use edit/write on owned files or the temp dir` };
		}
	}
	return undefined;
}

/** The gate for a role, or `undefined` when the call may proceed. */
export function checkGate(toolName: string, input: unknown, ctx: GateContext): GateBlock | undefined {
	switch (ctx.role) {
		case "git":
			if (toolName === "bash" && !isGitCommand(inputString(input, "command"), ctx.allow)) {
				return { block: true, reason: "the git role may run only read-only git commands (git log/blame/show/diff/status …), optionally after cd, piped only into head/grep/wc" };
			}
			return undefined;
		case "test":
			if (toolName === "bash" && !isTestCommand(inputString(input, "command"), ctx.allow)) {
				return {
					block: true,
					reason:
						"the test role may run only test runners and checks (npm test, npx vitest/jest/mocha, pytest, go test, cargo test, mvn/gradle test, phpunit, php -l, node --test, node --check, dotnet test, tsc --noEmit, git diff --check, any pwsh/powershell command), optionally after cd",
				};
			}
			return undefined;
		case "worker":
			return checkWorkerGate(toolName, input, ctx);
		default:
			return undefined;
	}
}
