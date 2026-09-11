/**
 * Subagent roles and the `<agent-dir>/toolkit/subagents.json` file that
 * overrides them. pi-free.
 *
 * ```json
 * {
 *   "cheapModels": ["deepseek/deepseek-v4-flash", "…"],   // preference order for model: "cheap"
 *   "maxParallel": 4,
 *   "defaultTimeoutSec": 900,
 *   "roles": {
 *     "researcher": { "model": "inherit", "thinking": "medium", "maxTurns": 25, "maxTokens": 600000,
 *                     "tools": ["read", "grep", "find", "ls", "bash"], "prompt": "…", "timeoutSec": 900,
 *                     "fallback": "deepseek/deepseek-v4-flash" },   // used when a local model server is down
 *     "test":       { "allow": ["^make check(\\s|$)"] },   // extra bash commands the git/test gate lets through
 *     "my-role":    { … any subset; missing fields come from a plain base … }
 *   }
 * }
 * ```
 *
 * The file is written with the defaults on first use and re-read on every
 * `delegate` call, so edits take effect without a restart.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../core/paths.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export interface RoleSpec {
	/** "inherit" (the parent's model) | "cheap" (first available of cheapModels) | "provider/id". */
	model: string;
	thinking: ThinkingLevel;
	maxTurns: number;
	/** Total input + output + cache tokens across the run. */
	maxTokens: number;
	tools: string[];
	/** Appended to the child's system prompt. */
	prompt: string;
	timeoutSec?: number;
	/** Used instead of `model` when that model is a local server that does not answer. */
	fallback?: string;
	/** Regex sources for extra bash commands the git/test gate lets through, matched per command of a chain. */
	allow?: string[];
}

export interface SubagentsConfig {
	cheapModels: string[];
	maxParallel: number;
	defaultTimeoutSec: number;
	roles: Record<string, RoleSpec>;
}

/**
 * Floor for every token cap. The cap counts input + output + cache over all
 * turns, so a caller that read it as an output limit (maxTokens: 5000) had
 * children killed after two tool calls.
 */
export const MIN_TOKEN_CAP = 250_000;

/** The token cap a child runs with: 0 (none) on a local model, which costs nothing; never under MIN_TOKEN_CAP otherwise. */
export function effectiveTokenCap(requested: number, local: boolean): number {
	return local ? 0 : Math.max(MIN_TOKEN_CAP, requested);
}

/** A caller's maxTokens only raises the role's cap: six researchers handed 250k instead of their 600k were all killed. */
export function raisedTokenCap(roleCap: number, requested: number | undefined): number {
	return Math.max(roleCap, requested ?? 0);
}

export const DEFAULT_ROLES: Record<string, RoleSpec> = {
	researcher: {
		model: "inherit",
		thinking: "medium",
		maxTurns: 25,
		maxTokens: 600_000,
		tools: ["read", "grep", "find", "ls", "bash"],
		prompt:
			"You are a codebase researcher. Answer the question with evidence: cite path:line for every claim. Read what you need; never edit files or run commands that change anything. Report findings first, then what you could not determine.",
	},
	scout: {
		model: "cheap",
		thinking: "low",
		maxTurns: 10,
		maxTokens: 250_000,
		tools: ["read", "grep", "find", "ls"],
		prompt:
			"You are a scout doing fast reconnaissance. Return a map of which files and directories matter for the task: each path with one line on why and what it contains. Prefer listings and grep over reading whole files. Never edit.",
	},
	finder: {
		model: "cheap",
		thinking: "off",
		maxTurns: 8,
		maxTokens: 250_000,
		tools: ["grep", "find", "ls", "read"],
		prompt:
			"You are a finder. Locate the files, symbols or usages asked for and return only paths with line numbers, one per line, with a short note where a match is ambiguous. No prose, no edits.",
	},
	git: {
		model: "cheap",
		thinking: "low",
		maxTurns: 12,
		maxTokens: 250_000,
		tools: ["bash", "read"],
		prompt:
			"You are a git historian. Use read-only git commands (log, blame, show, diff, status, shortlog); anything else is blocked. Report commits as short hash, date, author and subject and quote the relevant lines. Never modify the repository.",
	},
	web: {
		model: "cheap",
		thinking: "low",
		maxTurns: 12,
		maxTokens: 250_000,
		tools: ["web_search", "web_fetch"],
		prompt:
			"You are a web researcher. Search, read the sources, and report findings with the source URL after each claim. Prefer primary sources, note dates and versions, and say when sources disagree. Do not speculate beyond the sources.",
	},
	test: {
		model: "cheap",
		thinking: "off",
		maxTurns: 6,
		maxTokens: 250_000,
		tools: ["bash", "read"],
		prompt:
			"You are a test runner. Run only the given test command(s); other commands are blocked. Report pass/fail counts and, for failures, the test name, the assertion message and path:line. Do not fix anything and do not try other commands.",
	},
	worker: {
		model: "inherit",
		thinking: "medium",
		maxTurns: 40,
		maxTokens: 1_000_000,
		tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
		prompt:
			"You are a worker implementing one scoped task. Edit only the files you own (edits elsewhere are blocked); read anything. Verify the change where cheap (build, targeted test), then report per file what changed, what you verified, and anything left undone.",
	},
	session: {
		model: "cheap",
		thinking: "low",
		maxTurns: 10,
		maxTokens: 250_000,
		tools: ["session_search", "session_read"],
		prompt:
			"You answer questions from previous pi sessions of the last two weeks. Use session_search, then session_read on the hits; quote what was decided or done, with the session date. If nothing matches, say so plainly.",
	},
};

export const DEFAULT_CONFIG: SubagentsConfig = {
	cheapModels: ["deepseek/deepseek-v4-flash", "openai-codex/gpt-5.3-codex-spark", "github-copilot/gpt-5-mini", "anthropic/claude-haiku-4-5"],
	maxParallel: 4,
	defaultTimeoutSec: 900,
	roles: DEFAULT_ROLES,
};

/** Fields for a user-defined role that gives only some of them. */
const CUSTOM_ROLE_BASE: RoleSpec = { model: "cheap", thinking: "low", maxTurns: 10, maxTokens: 250_000, tools: ["read", "grep", "find", "ls"], prompt: "" };

export function subagentsConfigPath(toolkitDir: string): string {
	return join(toolkitDir, "subagents.json");
}

function cloneConfig(cfg: SubagentsConfig): SubagentsConfig {
	return {
		cheapModels: [...cfg.cheapModels],
		maxParallel: cfg.maxParallel,
		defaultTimeoutSec: cfg.defaultTimeoutSec,
		roles: Object.fromEntries(Object.entries(cfg.roles).map(([name, role]) => [name, { ...role, tools: [...role.tools], ...(role.allow ? { allow: [...role.allow] } : {}) }])),
	};
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function mergeRole(base: RoleSpec, override: unknown): RoleSpec {
	const out: RoleSpec = { ...base, tools: [...base.tools] };
	if (!override || typeof override !== "object" || Array.isArray(override)) return out;
	const o = override as Record<string, unknown>;
	if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
	if (isThinkingLevel(o.thinking)) out.thinking = o.thinking;
	const maxTurns = positiveInt(o.maxTurns);
	if (maxTurns !== undefined) out.maxTurns = maxTurns;
	const maxTokens = positiveInt(o.maxTokens);
	if (maxTokens !== undefined) out.maxTokens = maxTokens;
	if (Array.isArray(o.tools)) out.tools = o.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
	if (typeof o.prompt === "string") out.prompt = o.prompt;
	const timeoutSec = positiveInt(o.timeoutSec);
	if (timeoutSec !== undefined) out.timeoutSec = timeoutSec;
	if (typeof o.fallback === "string" && o.fallback.trim()) out.fallback = o.fallback.trim();
	if (Array.isArray(o.allow)) out.allow = o.allow.filter((a): a is string => typeof a === "string" && a.trim() !== "");
	return out;
}

/** Overrides merged over the defaults; unknown roles are added over a plain base. */
export function mergeSubagentsConfig(defaults: SubagentsConfig, override: unknown): SubagentsConfig {
	const out = cloneConfig(defaults);
	if (!override || typeof override !== "object" || Array.isArray(override)) return out;
	const o = override as Record<string, unknown>;
	if (Array.isArray(o.cheapModels)) out.cheapModels = o.cheapModels.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim());
	const maxParallel = positiveInt(o.maxParallel);
	if (maxParallel !== undefined) out.maxParallel = maxParallel;
	const defaultTimeoutSec = positiveInt(o.defaultTimeoutSec);
	if (defaultTimeoutSec !== undefined) out.defaultTimeoutSec = defaultTimeoutSec;
	if (o.roles && typeof o.roles === "object" && !Array.isArray(o.roles)) {
		for (const [name, spec] of Object.entries(o.roles as Record<string, unknown>)) {
			if (!/^[a-z][a-z0-9_-]*$/i.test(name)) continue;
			out.roles[name] = mergeRole(out.roles[name] ?? CUSTOM_ROLE_BASE, spec);
		}
	}
	return out;
}

/** Read the file (creating it with the defaults when missing) and merge it over the defaults. */
export function loadSubagentsConfig(path: string): SubagentsConfig {
	if (!existsSync(path)) {
		try {
			writeJsonAtomic(path, DEFAULT_CONFIG);
		} catch {}
		return cloneConfig(DEFAULT_CONFIG);
	}
	return mergeSubagentsConfig(DEFAULT_CONFIG, readJson<unknown>(path, undefined));
}
