/**
 * The one global rules file: `<agent-dir>/toolkit/permissions.json`.
 *
 * ```json
 * { "mode": "block", "workspaces": [], "allow": [], "deny": [], "askOnce": true }
 * ```
 *
 * Created with defaults on first use so it can be edited by hand; re-read
 * whenever its mtime or size changes, so edits and children stay in sync
 * without a restart. An unparsable file keeps the last good rules.
 */
import { readFileSync, statSync } from "node:fs";
import { toolkitPath, writeJsonAtomic } from "../../core/paths.ts";
import { DEFAULT_RULES, type Mode, type PermissionRules } from "./rules.ts";

export const MODES: Mode[] = ["block", "guard", "strict", "yolo"];

export function rulesPath(): string {
	return toolkitPath("permissions.json");
}

function freshDefaults(): PermissionRules {
	return { ...DEFAULT_RULES, workspaces: [], allow: [], deny: [] };
}

/** Coerce whatever is in the file into a valid rule set. */
export function normalizeRules(raw: unknown): PermissionRules {
	const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
	return {
		mode: MODES.includes(r.mode as Mode) ? (r.mode as Mode) : "block",
		workspaces: strings(r.workspaces),
		allow: strings(r.allow),
		deny: strings(r.deny),
		askOnce: typeof r.askOnce === "boolean" ? r.askOnce : true,
	};
}

export interface RulesStore {
	path: string;
	/** The current rules (cached until the file changes). Treat as read-only; change through `update`. */
	get(): PermissionRules;
	update(change: (rules: PermissionRules) => void): PermissionRules;
}

export function createRulesStore(path = rulesPath()): RulesStore {
	let cached: PermissionRules | undefined;
	let stamp = "";
	const stampOf = (): string => {
		try {
			const s = statSync(path);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "";
		}
	};
	const store: RulesStore = {
		path,
		get() {
			const now = stampOf();
			if (!now) {
				cached = freshDefaults();
				writeJsonAtomic(path, cached);
				stamp = stampOf();
				return cached;
			}
			if (cached && now === stamp) return cached;
			try {
				const text = readFileSync(path, "utf8");
				cached = normalizeRules(text.trim() ? JSON.parse(text) : {});
			} catch {
				cached = cached ?? freshDefaults();
			}
			stamp = now;
			return cached;
		},
		update(change) {
			const rules = store.get();
			change(rules);
			writeJsonAtomic(path, rules);
			stamp = stampOf();
			return rules;
		},
	};
	return store;
}
