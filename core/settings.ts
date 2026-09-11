/**
 * One settings file for the whole toolkit: `<agent-dir>/toolkit/settings.json`.
 *
 * ```json
 * {
 *   "modules": { "tool-style": true, "web": false },
 *   "compact": { "bashCapBytes": 8192 },
 *   "subagent": { ... }
 * }
 * ```
 *
 * `modules` holds the on/off switches the `/toolkit` menu edits. Every other
 * top-level key is that module's own configuration, merged over its defaults.
 */
import { readJson, toolkitPath, writeJsonAtomic } from "./paths.ts";

export interface ToolkitSettings {
	modules: Record<string, boolean>;
	[moduleId: string]: unknown;
}

export function settingsPath(): string {
	return toolkitPath("settings.json");
}

export function loadSettings(): ToolkitSettings {
	const raw = readJson<Partial<ToolkitSettings>>(settingsPath(), {});
	const modules = raw && typeof raw.modules === "object" && raw.modules ? raw.modules : {};
	return { ...raw, modules: { ...modules } } as ToolkitSettings;
}

export function saveSettings(settings: ToolkitSettings): void {
	writeJsonAtomic(settingsPath(), settings);
}

/** Deep-ish merge: one level of nested objects, arrays replaced wholesale. */
export function mergeConfig<T extends object>(defaults: T, override: unknown): T {
	if (!override || typeof override !== "object" || Array.isArray(override)) return { ...defaults };
	const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
		const base = out[key];
		if (value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object" && !Array.isArray(base)) {
			out[key] = { ...(base as Record<string, unknown>), ...(value as Record<string, unknown>) };
		} else {
			out[key] = value;
		}
	}
	return out as T;
}
