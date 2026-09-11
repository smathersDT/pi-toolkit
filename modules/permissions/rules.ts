/**
 * The decision engine of the permission gate. Pure: no pi, no filesystem.
 *
 *   decide(call) → { verdict: "allow" | "confirm" | "deny", reason, rule? }
 *
 * Two tiers of built-in findings plus the user's own rules:
 *
 *   block    refused without a dialog. "Hard" entries (the machine-destroying
 *            ones: rm -rf /, format, shell profiles, curl | sh, …) are refused
 *            in every mode but yolo. "Soft" entries (npm publish, kubectl
 *            delete, DROP DATABASE, …) can be lifted by an explicit allow rule.
 *   confirm  a dialog in guard mode, refused in strict mode, refused wherever
 *            no dialog is possible (a child process, no UI).
 *
 * Precedence: deny rule > hard block > allow rule > soft block > confirm.
 * Yolo allows everything except deny rules and only reports what it would
 * have done. Every deny reason starts with `[permissions]`.
 */
import { homedir } from "node:os";
import { posix } from "node:path";
import { canon, coversWhole, isFsRoot, protectedWhat, relativeTo, resolvePath, sameDir, within } from "./paths.ts";
import { parseCommand, type Segment } from "./shell.ts";

/**
 *   block   refuse the block tier only; everything else runs silently (default)
 *   guard   refuse the block tier, ask on the confirm tier
 *   strict  refuse both tiers, never ask
 *   yolo    allow everything except deny rules
 */
export type Mode = "block" | "guard" | "strict" | "yolo";
export type Verdict = "allow" | "confirm" | "deny";

export interface PermissionRules {
	mode: Mode;
	/** Directories writable without a dialog, besides the cwd, the temp dir and the toolkit dir. */
	workspaces: string[];
	/** `Bash(git push:*)`, `Write(/path/**)`, `re:^regex$`. */
	allow: string[];
	deny: string[];
	/** Remember "Allow once" for identical calls in this session. */
	askOnce: boolean;
}

export const DEFAULT_RULES: PermissionRules = { mode: "block", workspaces: [], allow: [], deny: [], askOnce: true };

export interface DecideCall {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	/** Every root that may be written silently (configured workspaces, temp dir, toolkit dir); the cwd is implied. */
	workspaces: string[];
	rules: PermissionRules;
	isChild: boolean;
	/** Default true. */
	hasUI?: boolean;
	/** Default os.homedir(). */
	home?: string;
}

export interface Decision {
	verdict: Verdict;
	reason: string;
	/** `block:<id>`, `confirm:<id>`, `allow:<pattern>`, `deny:<pattern>`. */
	rule?: string;
}

interface Finding {
	tier: "block" | "confirm";
	hard: boolean;
	what: string;
	rule: string;
}

const block = (rule: string, what: string, hard = true): Finding => ({ tier: "block", hard, what, rule: `block:${rule}` });
const confirm = (rule: string, what: string): Finding => ({ tier: "confirm", hard: false, what, rule: `confirm:${rule}` });

/** Directories a recursive delete inside a workspace may remove silently: build output and caches. */
export const DISPOSABLE_DIRS = new Set(["node_modules", "dist", "build", "target", ".cache", "tmp", "coverage", "__pycache__", ".next", ".nuxt", ".turbo", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);

/* ------------------------------------------------------------------------ */
/* Bash                                                                     */
/* ------------------------------------------------------------------------ */

const RAW_PATTERNS: Array<[RegExp, () => Finding]> = [
	[/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, () => block("fork-bomb", "a fork bomb")],
	[/\biex\s*\(|\binvoke-expression\b/i, () => block("iex", "Invoke-Expression (runs downloaded or generated code)")],
	[/\bdrop\s+(database|schema)\b/i, () => block("drop-database", "DROP DATABASE", false)],
	[/\bdrop\s+table\b/i, () => confirm("drop-table", "DROP TABLE")],
	[/\btruncate\s+table\b/i, () => confirm("truncate", "TRUNCATE TABLE")],
	[/\bTRUNCATE\s+[A-Za-z_"`[]/, () => confirm("truncate", "TRUNCATE")],
];

const INTERPRETERS = new Set(["sh", "bash", "zsh", "ksh", "dash", "fish", "pwsh", "powershell", "python", "python3", "perl", "ruby", "node", "iex"]);
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "invoke-webrequest", "fetch"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"]);

function gitFindings(args: string[]): Finding[] {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		if (/^-[Cc]$/.test(args[i]) || args[i] === "--git-dir" || args[i] === "--work-tree") i++;
		i++;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	const flags = rest.filter((a) => a.startsWith("-"));
	const positional = rest.filter((a) => !a.startsWith("-"));
	switch (sub) {
		case "push": {
			const force = flags.some((f) => f === "--force" || f.startsWith("--force-with-lease") || f.startsWith("--force-if-includes") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || positional.some((p) => p.startsWith("+"));
			if (!force) return [];
			const refspec = positional[1] ?? positional.find((p) => p.startsWith("+"));
			const branch = refspec?.replace(/^\+/, "").split(":").pop()?.replace(/^refs\/heads\//, "");
			if (branch && /^(main|master)$/.test(branch)) return [block("force-push-main", `git push --force to ${branch}`)];
			return [confirm("force-push", branch ? `git push --force to ${branch}` : "git push --force (branch not named; it could be main)")];
		}
		case "filter-branch":
			return [block("filter-branch", "git filter-branch (rewrites history)", false)];
		case "reset":
			return flags.includes("--hard") ? [confirm("git-reset-hard", "git reset --hard (discards uncommitted work)")] : [];
		case "checkout":
		case "restore": {
			const all = positional.some((p) => p === "." || p === "*" || p === ":/");
			return all ? [confirm("git-discard-all", `git ${sub} of the whole tree (discards uncommitted work)`)] : [];
		}
		case "clean":
			return flags.some((f) => f === "--force" || /^-[a-zA-Z]*f/.test(f)) ? [confirm("git-clean", "git clean -f (deletes untracked files)")] : [];
		case "branch": {
			const hard = flags.some((f) => /^-[a-zA-Z]*D/.test(f)) || (flags.some((f) => f === "-d" || f === "--delete") && flags.includes("--force"));
			return hard ? [confirm("git-branch-D", `git branch -D ${positional[0] ?? ""}`.trim())] : [];
		}
		default:
			return [];
	}
}

function segmentFindings(seg: Segment, prev: Segment | undefined): Finding[] {
	const out: Finding[] = [];
	const { verb, args } = seg;
	const first = args[0]?.toLowerCase();

	if (seg.wrappers.includes("sudo") || seg.wrappers.includes("doas")) out.push(confirm("sudo", `sudo: ${seg.raw}`));

	if (verb === "format" || verb === "diskpart" || /^mkfs(\.|$)/.test(verb)) out.push(block("disk", `${verb} (wipes a disk)`));
	else if (POWER.has(verb)) out.push(block("power", `${verb} (powers the machine off)`));
	else if (verb === "dd" && args.some((a) => /^of=\/dev\/(?!null$)/.test(a))) out.push(block("dd-device", "dd onto a device"));
	else if (verb === "reg" && first === "delete" && /^(hklm|hkey_local_machine)/i.test(args[1] ?? "")) out.push(block("registry", "reg delete under HKLM"));
	else if (verb === "iex" || verb === "invoke-expression") out.push(block("iex", "Invoke-Expression (runs downloaded or generated code)"));
	else if (INTERPRETERS.has(verb) && seg.op === "|" && prev && DOWNLOADERS.has(prev.verb)) out.push(block("pipe-to-shell", `${prev.verb} | ${verb} (runs code straight from the network)`));
	else if (verb === "git") out.push(...gitFindings(args));
	else if (verb === "npm" || verb === "pnpm" || verb === "yarn") {
		const global = args.some((a) => a === "-g" || a === "--global") || (verb === "yarn" && first === "global");
		if (first === "publish" || (verb === "yarn" && first === "npm" && args[1] === "publish")) out.push(block("publish", `${verb} publish`, false));
		else if (global && /^(install|i|add|global|link)$/.test(first ?? "")) out.push(confirm("global-install", `${verb} global install`));
	} else if (verb === "kubectl" && first === "delete") out.push(block("kubectl-delete", "kubectl delete", false));
	else if ((verb === "terraform" || verb === "tofu") && (args.includes("destroy") || args.includes("-destroy"))) out.push(block("terraform-destroy", `${verb} destroy`, false));
	else if (verb === "docker" && first === "system" && args[1] === "prune" && args.some((a) => a === "-a" || a === "--all")) out.push(block("docker-prune", "docker system prune -a", false));
	return out;
}

function bashFindings(command: string, cwd: string, roots: string[], home: string): Finding[] {
	const out: Finding[] = [];
	for (const [re, make] of RAW_PATTERNS) if (re.test(command)) out.push(make());

	const report = parseCommand(command, cwd, home);
	report.segments.forEach((seg, i) => out.push(...segmentFindings(seg, report.segments[i - 1])));

	for (const m of report.mutations) {
		if (!m.resolved) {
			out.push(confirm("unresolved", `${m.verb} ${m.target}: ${m.problem}`));
			continue;
		}
		const p = m.resolved.path;
		if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(p)) continue;
		const whole = coversWhole(m.resolved) && !m.filtered;
		const label = `${m.verb} on ${p}${m.resolved.glob ? `/${m.resolved.glob}` : ""}`;
		const wipes = m.kind === "delete" || m.kind === "move";
		// 1. the machine: `rm -rf /`, `rm -rf ~`, `chmod -R 777 /`
		if (whole && (wipes || (m.recursive && m.kind === "write")) && (isFsRoot(p) || sameDir(p, home))) {
			out.push(block("root-delete", `${label} (${isFsRoot(p) ? "the filesystem root" : "the home directory"})`));
			continue;
		}
		// 2. files that run later or belong to the OS
		const protectedAs = protectedWhat(p, home);
		if (protectedAs) {
			out.push(block("protected", `a ${m.kind} to ${protectedAs}: ${p}`));
			continue;
		}
		// 3. a workspace root itself (or an ancestor of one)
		if (whole && wipes && (m.recursive || m.kind === "move") && roots.some((r) => within(r, p))) {
			out.push(block("workspace-root", `${label} (a workspace root)`));
			continue;
		}
		// 4. anywhere nobody approved
		const root = roots.find((r) => within(p, r));
		if (!root) {
			out.push(confirm("outside", `a ${m.kind} outside every workspace: ${m.verb} ${p}`));
			continue;
		}
		// 5. inside: a recursive (or whole-directory) delete, unless it is build output
		if (m.kind === "delete" && (m.recursive || (m.resolved.glob !== undefined && whole))) {
			const parts = (relativeTo(p, root) ?? "").split("/").filter(Boolean);
			if (!parts.some((part) => DISPOSABLE_DIRS.has(part.toLowerCase()))) out.push(confirm("rm-rf", `recursive delete inside the workspace: ${label}`));
		}
	}
	return out;
}

/* ------------------------------------------------------------------------ */
/* write / edit                                                             */
/* ------------------------------------------------------------------------ */

function pathFindings(tool: string, target: string | undefined, roots: string[], home: string): Finding[] {
	if (!target) return [];
	const protectedAs = protectedWhat(target, home);
	if (protectedAs) return [block("protected", `a ${tool} to ${protectedAs}: ${target}`)];
	if (!roots.some((r) => within(target, r))) return [confirm("outside", `a ${tool} outside every workspace: ${target}`)];
	return [];
}

/* ------------------------------------------------------------------------ */
/* User rules                                                               */
/* ------------------------------------------------------------------------ */

/** `src/**\/*.ts` → anchored, case-insensitive RegExp over canonical paths. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	const g = canon(glob);
	for (let i = 0; i < g.length; i++) {
		const ch = g[i];
		if (ch === "/" && g.slice(i + 1) === "**") return new RegExp(`^${re}(?:/.*)?$`, "i"); // `dir/**` includes dir itself
		if (ch === "*") {
			if (g[i + 1] === "*") {
				i++;
				if (g[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else re += ".*";
			} else re += "[^/]*";
		} else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * Does one rule pattern match this call?
 *   Bash(<prefix>:*)   prefix match on the command (word boundary)
 *   Bash(<exact>)      exact command;  Bash / Bash(*)  any bash
 *   Write(<glob>) / Edit(<glob>)  glob on the resolved path of write/edit
 *   re:<regex>         regex on the command (bash) or the path (write/edit)
 */
export function matchRule(pattern: string, tool: string, subject: string, target: string | undefined, cwd: string): boolean {
	const p = pattern.trim();
	if (p.startsWith("re:")) {
		try {
			return new RegExp(p.slice(3)).test(tool === "bash" ? subject : (target ?? subject));
		} catch {
			return false;
		}
	}
	const m = /^([A-Za-z]+)(?:\(([\s\S]*)\))?$/.exec(p);
	if (!m) return false;
	const kind = m[1].toLowerCase();
	const inner = m[2]?.trim();
	if (kind === "bash") {
		if (tool !== "bash") return false;
		if (inner === undefined || inner === "" || inner === "*") return true;
		const cmd = subject.trim();
		if (inner.endsWith(":*")) {
			const prefix = inner.slice(0, -2).trim();
			if (!cmd.startsWith(prefix)) return false;
			return cmd.length === prefix.length || /\s/.test(cmd[prefix.length]) || !/\w$/.test(prefix);
		}
		return cmd === inner;
	}
	if (kind === "write" || kind === "edit") {
		if ((tool !== "write" && tool !== "edit") || !target) return false;
		if (inner === undefined || inner === "" || inner === "*" || inner === "**") return true;
		const glob = inner.replace(/^~(?=[\\/]|$)/, canon(homedir()));
		const absolute = /^([a-zA-Z]:[\\/]|\/)/.test(glob);
		if (absolute) return globToRegExp(glob).test(target);
		const rel = relativeTo(target, canon(cwd));
		return globToRegExp(glob).test(rel ?? target);
	}
	return false;
}

/** The rule "Allow always" saves: the first two words of a command, or the target's directory. */
export function ruleFor(tool: string, subject: string, cwd: string, home = homedir()): string {
	if (tool === "bash") return `Bash(${subject.trim().split(/\s+/).slice(0, 2).join(" ")}:*)`;
	const target = resolvePath(subject, cwd, home, { literal: true })?.path ?? canon(subject);
	return `Write(${posix.dirname(target)}/**)`;
}

/** The string rules and the cache key are matched against: the command or the path. */
export function subjectOf(tool: string, input: Record<string, unknown> | undefined): string | undefined {
	if (!input) return undefined;
	if (tool === "bash") return typeof input.command === "string" ? input.command : undefined;
	if (tool === "write" || tool === "edit") return typeof input.path === "string" ? input.path : undefined;
	return undefined;
}

/* ------------------------------------------------------------------------ */
/* decide                                                                   */
/* ------------------------------------------------------------------------ */

const strength = (f: Finding): number => (f.tier === "block" ? (f.hard ? 2 : 1) : 0);

export function decide(call: DecideCall): Decision {
	const tool = call.tool;
	const subject = subjectOf(tool, call.input);
	if (subject === undefined) return { verdict: "allow", reason: "" };

	const home = canon(call.home ?? homedir());
	const cwd = canon(call.cwd);
	const roots = [cwd, ...call.workspaces.map(canon)];
	const target = tool === "bash" ? undefined : resolvePath(subject, call.cwd, home, { literal: true })?.path;
	const findings = tool === "bash" ? bashFindings(subject, cwd, roots, home) : pathFindings(tool, target, roots, home);
	const worst = findings.length ? findings.reduce((a, b) => (strength(b) > strength(a) ? b : a)) : undefined;
	const { mode } = call.rules;
	const deny = (reason: string, rule: string): Decision => ({ verdict: "deny", reason: `[permissions] refused: ${reason}`, rule });

	const denyRule = call.rules.deny.find((p) => matchRule(p, tool, subject, target, call.cwd));
	if (denyRule) return deny(`deny rule "${denyRule}" matches`, `deny:${denyRule}`);

	if (mode === "yolo") {
		const note = worst ? `yolo mode: would have ${worst.tier === "block" ? "refused" : "asked about"} ${worst.what}` : "yolo mode";
		return { verdict: "allow", reason: note, rule: worst?.rule };
	}
	if (worst?.tier === "block" && worst.hard) return deny(`${worst.what} (block tier; only yolo mode runs this)`, worst.rule);

	const allowRule = call.rules.allow.find((p) => matchRule(p, tool, subject, target, call.cwd));
	if (allowRule) return { verdict: "allow", reason: `allowed by rule "${allowRule}"`, rule: `allow:${allowRule}` };

	if (worst?.tier === "block") return deny(`${worst.what} (block tier; add an allow rule or use yolo mode)`, worst.rule);
	if (!worst) return { verdict: "allow", reason: "" };

	// Block mode: only the block tier is refused; the confirm tier runs without a dialog.
	if (mode === "block") return { verdict: "allow", reason: `block mode: ${worst.what} runs without confirmation`, rule: worst.rule };
	if (mode === "strict") return deny(`${worst.what} needs confirmation and strict mode never asks`, worst.rule);
	if (call.isChild) return deny(`${worst.what} needs confirmation and a child process has no dialog (${mode} mode)`, worst.rule);
	if (call.hasUI === false) return deny(`${worst.what} needs confirmation and this session has no UI (${mode} mode)`, worst.rule);
	return { verdict: "confirm", reason: worst.what, rule: worst.rule };
}
