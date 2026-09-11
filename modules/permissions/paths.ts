/**
 * Path helpers for the permission gate: one canonical, comparable form for
 * Windows (`C:\dev\x`, `C:/dev/x`), Git Bash (`/c/dev/x`) and POSIX paths,
 * resolution of a command operand against the cwd, and the containment test
 * every workspace rule is built on. No pi imports and no filesystem access,
 * so it runs the same in tests, in children and on either OS.
 */
import { posix, win32 } from "node:path";

/** `c:/dev/x` or `/home/u/x`: forward slashes, lower-cased drive, no trailing slash (roots keep theirs). */
export function canon(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	const gitBash = /^\/([a-zA-Z])(?=\/|$)/.exec(s);
	if (gitBash) s = `${gitBash[1]}:${s.slice(2) || "/"}`;
	if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
	if (/^[a-z]:$/.test(s)) s += "/";
	s = s.replace(/\/{2,}/g, "/");
	if (s.length > 1 && s.endsWith("/") && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
	return s;
}

export function isDriveForm(s: string): boolean {
	return /^[a-z]:\//.test(s);
}

/** `/` or a drive root. */
export function isFsRoot(s: string): boolean {
	return s === "/" || /^[a-z]:\/$/.test(s);
}

/** Is `target` equal to or under `root`? Both canonical. Case-insensitive: Windows and macOS are. */
export function within(target: string, root: string): boolean {
	const t = target.toLowerCase();
	const r = root.toLowerCase();
	if (t === r) return true;
	return t.startsWith(r.endsWith("/") ? r : `${r}/`);
}

export function sameDir(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

export interface Resolved {
	/** Canonical absolute path. */
	path: string;
	/** The first wildcard component, which ended the path: `src/*.log` resolves to `src` with glob `*.log`. */
	glob?: string;
}

/** An exact path, or a glob that takes everything under it (`*`, `**`, `.*`). */
export function coversWhole(r: Resolved): boolean {
	return !r.glob || /^\.?\*{1,2}$/.test(r.glob);
}

export interface ResolveOptions {
	/** Tool paths are literal: no `$var` rejection, no wildcard cut. */
	literal?: boolean;
}

/**
 * Resolve a command operand (or a tool path) against the cwd. `~`, `$HOME`
 * and `%USERPROFILE%` expand to home. In shell mode any other `$var`, `%var%`
 * or backtick returns undefined: the gate cannot know where it lands.
 */
export function resolvePath(raw: string, cwd: string, home: string, options: ResolveOptions = {}): Resolved | undefined {
	let s = raw.trim();
	if (!s || s === "-") return undefined;
	s = s
		.replace(/^~(?=[\\/]|$)/, home)
		.replace(/^\$(HOME|\{HOME\})(?=[\\/]|$)/, home)
		.replace(/^%USERPROFILE%(?=[\\/]|$)/i, home);
	if (!options.literal && /[$`%]/.test(s)) return undefined;

	let path = canon(s);
	let glob: string | undefined;
	if (!options.literal) {
		const parts = path.split("/");
		const cut = parts.findIndex((part) => /[*?[]/.test(part));
		if (cut >= 0) {
			glob = parts[cut];
			const head = parts.slice(0, cut).join("/");
			path = head === "" ? (path.startsWith("/") ? "/" : ".") : /^[a-z]:$/.test(head) ? `${head}/` : head;
		}
	}

	const base = canon(cwd);
	let abs: string;
	if (path.startsWith("/")) abs = posix.normalize(path);
	else if (isDriveForm(path)) abs = win32.normalize(path);
	else if (isDriveForm(base)) abs = win32.resolve(base, path);
	else abs = posix.resolve(base, path);
	return glob === undefined ? { path: canon(abs) } : { path: canon(abs), glob };
}

/** The path relative to `root` (canonical, forward slashes), or undefined when not inside. */
export function relativeTo(target: string, root: string): string | undefined {
	if (!within(target, root)) return undefined;
	const r = root.endsWith("/") ? root : `${root}/`;
	return target.length <= r.length ? "" : target.slice(r.length);
}

const POSIX_SYSTEM = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/system", "/private/etc"];

/**
 * Locations a coding agent has no business writing to, however the write is
 * spelled: system directories, shell profiles, ~/.ssh, git hooks, the
 * Windows Startup folder. Returns what the path is, or undefined.
 */
export function protectedWhat(target: string, home: string): string | undefined {
	const t = target.toLowerCase();
	const h = canon(home).toLowerCase();
	if (/^[a-z]:\/(windows|program files( \(x86\))?)(\/|$)/.test(t) || POSIX_SYSTEM.some((root) => within(t, root))) return "a system directory";
	if (/(^|\/)\.git\/hooks(\/|$)/.test(t)) return "a git hook";
	if (/\/microsoft\/windows\/start menu\/programs\/startup(\/|$)/.test(t)) return "the Windows Startup folder";
	if (within(t, `${h}/.ssh`)) return "~/.ssh";
	const rel = relativeTo(t, h);
	if (rel !== undefined) {
		if (/^\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zshenv|zlogin|zlogout|cshrc|tcshrc|kshrc|mkshrc)$/.test(rel)) return "a shell profile";
		if (rel === ".config/fish/config.fish" || rel.startsWith(".config/fish/conf.d/")) return "a shell profile";
		if (/^documents\/(windows)?powershell\/[^/]*profile[^/]*\.ps1$/.test(rel)) return "a PowerShell profile";
	}
	return undefined;
}
