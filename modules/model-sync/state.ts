/**
 * `<agent-dir>/toolkit/model-sync/state.json` (run stamps + the DeepSeek band
 * table) and `log.jsonl` (one line per provider per run).
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../../core/paths.ts";
import type { Band, BandName, Schedule } from "./parsers.ts";
import { validRates } from "./prices.ts";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export interface RunStamp {
	/** Last successful run (ISO). */
	ok?: string;
	/** Last attempt, successful or not (ISO). */
	attempt?: string;
	error?: string;
}

export interface DeepSeekState {
	fetchedAt: string;
	/** Keyed by the id the page lists; aliases resolve at apply time. */
	models: Record<string, Band>;
	schedule: Schedule;
	/** The band whose prices models.json currently holds. */
	applied?: BandName;
}

export interface SyncState {
	version: 1;
	runs: Record<string, RunStamp>;
	deepseek?: DeepSeekState;
}

export function stateDir(agentDir: string): string {
	return join(agentDir, "toolkit", "model-sync");
}

export function statePath(agentDir: string): string {
	return join(stateDir(agentDir), "state.json");
}

export function ledgerPath(agentDir: string): string {
	return join(stateDir(agentDir), "log.jsonl");
}

function validSchedule(s: unknown): s is Schedule {
	if (!s || typeof s !== "object") return false;
	const { days, windows } = s as Schedule;
	return (
		Array.isArray(days) &&
		days.length > 0 &&
		days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
		Array.isArray(windows) &&
		windows.length > 0 &&
		windows.every((w) => Array.isArray(w) && w.length === 2 && w.every(Number.isFinite) && w[0] >= 0 && w[0] < w[1] && w[1] <= 1440)
	);
}

function validDeepSeek(d: unknown): d is DeepSeekState {
	if (!d || typeof d !== "object") return false;
	const { fetchedAt, models, schedule, applied } = d as DeepSeekState;
	if (!Number.isFinite(Date.parse(fetchedAt ?? "")) || !validSchedule(schedule)) return false;
	if (applied !== undefined && applied !== "peak" && applied !== "off-peak") return false;
	if (!models || typeof models !== "object") return false;
	const bands = Object.values(models);
	return bands.length > 0 && bands.every((b) => b && validRates(b.peak) && validRates(b.offPeak));
}

/** The state file, or a fresh one; an unreadable or invalid DeepSeek block is dropped. */
export function readState(agentDir: string): SyncState {
	const raw = readJson<Partial<SyncState>>(statePath(agentDir), {});
	const state: SyncState = { version: 1, runs: {} };
	if (raw.runs && typeof raw.runs === "object") {
		for (const [provider, stamp] of Object.entries(raw.runs)) {
			if (stamp && typeof stamp === "object") state.runs[provider] = { ...stamp };
		}
	}
	if (validDeepSeek(raw.deepseek)) state.deepseek = raw.deepseek;
	return state;
}

export function writeState(agentDir: string, state: SyncState): void {
	writeJsonAtomic(statePath(agentDir), state);
}

/**
 * Due when the last success is older than `everyMs` (default a day), but not
 * within `retryMs` (default an hour) of a failed attempt: ten sessions are not
 * ten fetches, and a box with no network is not hammered either.
 */
export function isDue(state: SyncState, provider: string, now = Date.now(), everyMs = DAY_MS, retryMs = HOUR_MS): boolean {
	const stamp = state.runs[provider];
	const ok = Date.parse(stamp?.ok ?? "");
	if (Number.isFinite(ok) && now - ok < everyMs) return false;
	const attempt = Date.parse(stamp?.attempt ?? "");
	if (Number.isFinite(attempt) && now - attempt < retryMs) return false;
	return true;
}

export interface LedgerRow {
	provider: string;
	ok: boolean;
	changed: string[];
	error?: string;
}

/** `{t, provider, ok, changed, error?}` appended to log.jsonl. Never throws. */
export function appendLedger(agentDir: string, row: LedgerRow, at = new Date()): void {
	try {
		ensureDir(stateDir(agentDir));
		const line: Record<string, unknown> = { t: at.toISOString(), provider: row.provider, ok: row.ok, changed: row.changed };
		if (row.error) line.error = row.error;
		appendFileSync(ledgerPath(agentDir), `${JSON.stringify(line)}\n`, "utf8");
	} catch {
		// A ledger that cannot be written must not fail the sync.
	}
}
