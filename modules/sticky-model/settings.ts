/**
 * The merge into pi's own settings.json. No pi imports, so the tests run under
 * bare node.
 *
 * Read-modify-write rather than a held copy: pi's SettingsManager keeps its own
 * in-memory settings and, on save, merges only the fields it marked modified
 * onto whatever the file says at that moment — so keys it never touched survive
 * its writes, and its writes survive these.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../../core/paths.ts";

export type Settings = Record<string, unknown>;

/** The keys this module owns. `thinkingFor` is one entry of `modelThinkingLevels`. */
export interface Changes {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	thinkingFor?: { key: string; level: string };
}

/**
 * The settings object to write, or `undefined` when the file already says this.
 * A no-op write is worth detecting: every save races pi's own, and the common
 * case — reopening on yesterday's model — changes nothing at all.
 */
export function patch(current: Settings, changes: Changes): Settings | undefined {
	const next = { ...current };
	let changed = false;
	for (const key of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) {
		const value = changes[key];
		if (value !== undefined && next[key] !== value) {
			next[key] = value;
			changed = true;
		}
	}
	if (changes.thinkingFor) {
		const { key, level } = changes.thinkingFor;
		const levels = current.modelThinkingLevels;
		const base = levels && typeof levels === "object" && !Array.isArray(levels) ? (levels as Record<string, unknown>) : {};
		if (base[key] !== level) {
			next.modelThinkingLevels = { ...base, [key]: level };
			changed = true;
		}
	}
	return changed ? next : undefined;
}

/**
 * The current settings: `{}` for a missing or empty file, `undefined` for one
 * that exists but does not parse — that one is left alone, because overwriting
 * it would silently discard whatever pi failed to read.
 */
export function readSettings(file: string): Settings | undefined {
	if (!existsSync(file)) return {};
	try {
		const raw = readFileSync(file, "utf8");
		if (!raw.trim()) return {};
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Settings) : undefined;
	} catch {
		return undefined;
	}
}

/** Merge `changes` into the settings file. Returns whether anything was written. */
export function remember(file: string, changes: Changes): boolean {
	const current = readSettings(file);
	if (!current) return false;
	const next = patch(current, changes);
	if (!next) return false;
	try {
		writeJsonAtomic(file, next);
		return true;
	} catch {
		return false;
	}
}
