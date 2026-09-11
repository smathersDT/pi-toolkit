/**
 * `<agent-dir>/models.json`: read the way pi reads it (BOM and comments
 * tolerated), touch only what the sync owns, back up, write atomically.
 *
 * Shape written:
 *
 *   providers.<provider>.modelOverrides.<id>.cost   — the four rates (+ tiers when known)
 *   providers.<provider>.models[].cost              — same, when the user defined the id explicitly
 *   providers["github-copilot"].models              — the whole Copilot catalogue block
 *
 * Everything else in the file is preserved. Nothing is written when the merged
 * file would be identical to what is on disk.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../../core/paths.ts";
import type { CopilotEntry } from "./copilot.ts";
import type { Cost } from "./prices.ts";

export interface ModelsConfig {
	providers: Record<string, any>;
	[key: string]: unknown;
}

export const BACKUP_KEEP = 3;

export function modelsJsonPath(agentDir: string): string {
	return join(agentDir, "models.json");
}

/** Comments outside strings and a BOM, the same tolerance pi's loader has. */
function parseLenient(text: string): unknown {
	const stripped = text.replace(/^\uFEFF/, "").replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str) => str ?? "");
	return JSON.parse(stripped);
}

export function loadModelsJson(path: string): { config: ModelsConfig } | { error: string } {
	if (!existsSync(path)) return { config: { providers: {} } };
	let parsed: unknown;
	try {
		const text = readFileSync(path, "utf8");
		parsed = text.trim() ? parseLenient(text) : { providers: {} };
	} catch (error) {
		return { error: `models.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "models.json is not an object" };
	const config = parsed as ModelsConfig;
	config.providers ??= {};
	if (typeof config.providers !== "object" || Array.isArray(config.providers)) return { error: "models.json providers is not an object" };
	return { config };
}

/** Write `cost` for the given ids under one provider, touching nothing else. */
export function mergeCosts(config: ModelsConfig, provider: string, costs: Record<string, Cost>): void {
	const block = (config.providers[provider] ??= {});
	if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`providers.${provider} is not an object`);
	const overrides = (block.modelOverrides ??= {});
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error(`providers.${provider}.modelOverrides is not an object`);
	for (const [id, cost] of Object.entries(costs)) {
		const prev = overrides[id] && typeof overrides[id] === "object" ? overrides[id] : {};
		overrides[id] = { ...prev, cost: { ...(prev.cost && typeof prev.cost === "object" ? prev.cost : {}), ...cost } };
		if (Array.isArray(block.models)) {
			for (const m of block.models) {
				if (m && typeof m === "object" && m.id === id) m.cost = { ...(m.cost && typeof m.cost === "object" ? m.cost : {}), ...cost };
			}
		}
	}
}

/** Replace the Copilot catalogue block's models; keep the block's other keys (baseUrl, headers…). */
export function mergeCopilotModels(config: ModelsConfig, models: CopilotEntry[]): void {
	const prev = config.providers["github-copilot"];
	const block = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
	config.providers["github-copilot"] = { ...block, models };
}

/** Keep the newest `keep` backups. */
export function rotateBackups(dir: string, keep = BACKUP_KEEP): void {
	const stamp = (name: string) => Number(name.match(/^models\.json\.bak\.(\d+)/)?.[1] ?? 0);
	const backups = readdirSync(dir)
		.filter((n) => /^models\.json\.bak\.\d+/.test(n))
		.sort((a, b) => stamp(b) - stamp(a) || b.localeCompare(a));
	for (const name of backups.slice(keep)) rmSync(join(dir, name), { force: true });
}

export interface ApplyResult {
	path: string;
	written: boolean;
	error?: string;
}

/** Read, mutate, compare, back up, write. Unchanged content writes nothing. */
export function applyModelsJson(agentDir: string, mutate: (config: ModelsConfig) => void, keep = BACKUP_KEEP): ApplyResult {
	const path = modelsJsonPath(agentDir);
	const loaded = loadModelsJson(path);
	if ("error" in loaded) return { path, written: false, error: loaded.error };
	const before = JSON.stringify(loaded.config);
	const config = structuredClone(loaded.config);
	try {
		mutate(config);
	} catch (error) {
		return { path, written: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (JSON.stringify(config) === before) return { path, written: false };
	try {
		if (existsSync(path)) {
			let backup = `${path}.bak.${Date.now()}`;
			while (existsSync(backup)) backup += "1";
			copyFileSync(path, backup);
			rotateBackups(dirname(path), keep);
		}
		writeJsonAtomic(path, config);
	} catch (error) {
		return { path, written: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { path, written: true };
}
