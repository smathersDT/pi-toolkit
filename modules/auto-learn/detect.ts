/**
 * Which directories a tool call touches, and the git work tree each one is in,
 * so a session working in a second repo gets that repo's lessons. pi-free.
 *
 *   path tools   the `path` argument (read, edit, write, grep, find, ls)
 *   bash         `cd <dir>` targets and absolute paths in the command
 *                (C:\x, C:/x, /c/x from Git Bash, ~/x; /x elsewhere)
 *
 * The walk up to a `.git` entry is cached per directory, so a session pays a
 * few stat calls per new directory and nothing after.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
/** Enough for any real call; a command full of paths does not buy a stat storm. */
const MAX_PATHS = 8;

const unquote = (s: string): string => s.replace(/^["']|["']$/g, "");

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
}

/** Git Bash spells C:\dev as /c/dev. */
function fromMsys(p: string, platform: string): string {
	if (platform !== "win32") return p;
	const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
	return m ? `${m[1].toUpperCase()}:${m[2] ?? "/"}` : p;
}

function absolute(raw: string, cwd: string, platform: string): string | undefined {
	const p = fromMsys(expandHome(unquote(raw.trim()).replace(/^@/, "")), platform);
	if (!p) return undefined;
	try {
		return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
	} catch {
		return undefined;
	}
}

/** The absolute paths a call names, in order, without duplicates. */
export function callPaths(toolName: string, input: Record<string, unknown> | undefined, cwd: string, platform: string = process.platform): string[] {
	const raw: string[] = [];
	if (PATH_TOOLS.has(toolName) && typeof input?.path === "string") raw.push(input.path);
	if (toolName === "bash" && typeof input?.command === "string") {
		const command = input.command;
		for (const m of command.matchAll(/(?:^|[;&|(\n]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) raw.push(m[1]);
		const looksAbsolute = platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/|~[\\/])/ : /^(?:\/.|~\/)/;
		// Words, with quoted strings kept whole so "C:/dev/x y" stays one path.
		for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"'`|;&<>()=]+)/g)) {
			const word = m[1] ?? m[2] ?? m[3] ?? "";
			if (looksAbsolute.test(word)) raw.push(word);
		}
	}
	const out: string[] = [];
	for (const r of raw) {
		const p = absolute(r, cwd, platform);
		if (p && !out.includes(p)) out.push(p);
		if (out.length >= MAX_PATHS) break;
	}
	return out;
}

const roots = new Map<string, string | null>();

/** The nearest directory at or above `path` holding a `.git` entry, or undefined outside git. */
export function gitRootOf(path: string, exists: (p: string) => boolean = existsSync): string | undefined {
	const visited: string[] = [];
	let dir = path;
	let found: string | null = null;
	for (;;) {
		const cached = roots.get(dir);
		if (cached !== undefined) {
			found = cached;
			break;
		}
		visited.push(dir);
		if (exists(join(dir, ".git"))) {
			found = dir;
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const v of visited) roots.set(v, found);
	return found ?? undefined;
}

export function resetRootCache(): void {
	roots.clear();
}
