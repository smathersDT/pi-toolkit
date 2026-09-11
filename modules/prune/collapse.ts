/**
 * The cut itself, and the test for whether this session is exempt from it.
 *
 * Node builtins only, so the tests run under bare node. Everything pi owns
 * (the agent dir, the cwd) arrives as an argument.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** First line of the block pi appends after its guidelines list. */
const DOCS_START = "Pi documentation (read only when";
/** The bullet whose path the collapsed line keeps. */
const DOCS_PATH_BULLET = /^- Additional docs:\s*(.+?)\s*$/;
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** True when `child` is `parent` or sits underneath it. */
export function contains(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `PI_TOOLKIT_PRUNE_DOCS=always` collapses even inside a pi project, `never`
 * keeps the full section everywhere. Anything else leaves it to `isPiProject`.
 */
export function forcedCollapse(env: Record<string, string | undefined> = process.env): boolean | null {
	switch ((env.PI_TOOLKIT_PRUNE_DOCS ?? "").trim().toLowerCase()) {
		case "always":
			return true;
		case "never":
			return false;
		default:
			return null;
	}
}

/**
 * Does this session plausibly develop pi itself? Yes when cwd is the agent dir
 * or under it (extensions, agents, themes live there), or when a package.json
 * at or above cwd names the pi package (an extension or SDK project).
 */
export function isPiProject(cwd: string, agentDir: string): boolean {
	if (contains(agentDir, cwd)) return true;
	let dir = resolve(cwd);
	for (;;) {
		const manifest = resolve(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				if (readFileSync(manifest, "utf8").includes(PACKAGE_NAME)) return true;
			} catch {
				// An unreadable manifest is not evidence either way; keep walking.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

export function collapsedLine(docsPath: string): string {
	return `Pi's own README, docs/ and examples/ live beside ${docsPath} — read them only when the user asks about pi itself.`;
}

/**
 * Replace pi's documentation block — the "Pi documentation (read only when…"
 * line and the bullet list under it — with one line that keeps the docs path.
 *
 * Both anchors must be found (the start line, and a bullet list carrying the
 * docs path) or the prompt is returned identity-equal: a partial cut would eat
 * the guidelines above or the project context below. Idempotent, because the
 * replacement line never matches the start anchor.
 */
export function collapseDocsSection(prompt: string): string {
	const lines = prompt.split("\n");
	const start = lines.findIndex((line) => line.startsWith(DOCS_START));
	if (start === -1) return prompt;
	let end = start + 1;
	while (end < lines.length && lines[end].startsWith("- ")) end++;
	if (end === start + 1) return prompt;
	let docsPath: string | undefined;
	for (let i = start + 1; i < end; i++) {
		const match = DOCS_PATH_BULLET.exec(lines[i]);
		if (match) {
			docsPath = match[1];
			break;
		}
	}
	if (!docsPath) return prompt;
	return [...lines.slice(0, start), collapsedLine(docsPath), ...lines.slice(end)].join("\n");
}
