/**
 * Which repo a working directory belongs to, so clones and worktrees share one
 * lesson file. Preference order:
 *
 *   1. the normalized origin remote   github.com/acme/widgets      (shared by every clone)
 *   2. the git common dir             c:/dev/widgets               (shared by worktrees of one clone)
 *   3. the directory itself           c:/dev/scratch               (no git at all)
 *
 * key = sanitized label + "-" + 8 hex chars of sha1(label), e.g.
 * `github.com__acme__widgets-1a2b3c4d`. Resolved once per cwd per process.
 * No pi imports; git is invoked synchronously and every failure falls through.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface RepoIdentity {
	key: string;
	/** Human-readable identity: the normalized remote or a lowercase forward-slash path. */
	label: string;
	source: "remote" | "common-dir" | "path";
}

export type GitRunner = (cwd: string, args: string[]) => string | undefined;

export function runGit(cwd: string, args: string[]): string | undefined {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

export function gitAvailable(): boolean {
	return runGit(process.cwd(), ["--version"]) !== undefined;
}

/**
 * Collapse every spelling of one remote onto one string:
 *   git@github.com:Acme/Widgets.git · https://github.com/acme/widgets · ssh://git@github.com/acme/widgets.git
 * all become "github.com/acme/widgets".
 */
export function normalizeRemote(raw: string): string {
	let s = raw.trim().toLowerCase();
	if (/^[a-z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("file://")) {
		// Local path remote (incl. Windows drive letters): separators only.
		s = s.replace(/^file:\/\//, "").replace(/\\/g, "/");
		s = s.replace(/^\/+([a-z]:)/, "$1");
	} else {
		s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
		s = s.replace(/^[^@/]+@/, ""); // user@
		s = s.replace(/^([^/:]+):(?!\/)/, "$1/"); // scp-style host:path
	}
	return s.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

/** "github.com/acme/widgets" → "github.com__acme__widgets"; "c:/dev/my repo" → "c__dev__my-repo". */
export function sanitizeLabel(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/:/g, "")
			.replace(/\/+/g, "__")
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^[-_.]+|[-_.]+$/g, "")
			.slice(0, 80) || "repo"
	);
}

export function keyFor(label: string): string {
	return `${sanitizeLabel(label)}-${createHash("sha1").update(label).digest("hex").slice(0, 8)}`;
}

function pathLabel(p: string): string {
	let real = p;
	try {
		real = realpathSync.native(p);
	} catch {
		/* keep as given */
	}
	return real.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const byCwd = new Map<string, RepoIdentity>();
const byKey = new Map<string, RepoIdentity>();

/** Never null: a directory outside git is keyed on its own path. */
export function resolveRepo(cwd: string, git: GitRunner = runGit): RepoIdentity {
	const cached = byCwd.get(cwd);
	if (cached) return cached;
	let label: string;
	let source: RepoIdentity["source"];
	// --local, not a plain --get: a bare lookup also reads global config, and one
	// stray global remote.origin.url would collapse every directory onto one repo.
	const remote = git(cwd, ["config", "--local", "--get", "remote.origin.url"]);
	if (remote) {
		label = normalizeRemote(remote);
		source = "remote";
	} else {
		const common = git(cwd, ["rev-parse", "--git-common-dir"]);
		if (common) {
			// Relative (".git") in the main worktree, absolute in a linked one.
			const abs = resolve(cwd, common);
			label = pathLabel(basename(abs) === ".git" ? dirname(abs) : abs);
			source = "common-dir";
		} else {
			label = pathLabel(cwd);
			source = "path";
		}
	}
	const key = keyFor(label);
	// One object per repo, so a subdirectory resolves to the identity already known.
	const identity: RepoIdentity = byKey.get(key) ?? { key, label, source };
	byCwd.set(cwd, identity);
	byKey.set(key, identity);
	return identity;
}

/** A repo seen in this process, by key or by label (any remote spelling). */
export function findRepo(keyOrLabel: string): RepoIdentity | undefined {
	const s = keyOrLabel.trim();
	if (!s) return undefined;
	const direct = byKey.get(s);
	if (direct) return direct;
	const label = normalizeRemote(s);
	for (const repo of byKey.values()) if (repo.label === label || repo.label === s.toLowerCase()) return repo;
	return undefined;
}

export function knownRepos(): RepoIdentity[] {
	return [...byKey.values()];
}

export function resetRepoCache(): void {
	byCwd.clear();
	byKey.clear();
}
