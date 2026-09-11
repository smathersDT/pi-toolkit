/**
 * The global prompt history file: `<agent-dir>/toolkit/history.json`, one JSON
 * array, newest first. Pi-free.
 *
 * pi's editor history lives only in memory, so closing pi loses everything you
 * typed. Writes are read-merge-write so two pi instances do not clobber each
 * other, and every failure is swallowed: history is a convenience, never a
 * reason for the editor to break.
 */
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../core/paths.ts";

export const MAX_ENTRIES = 200;

export function historyFile(agentDir: string): string {
	return join(agentDir, "toolkit", "history.json");
}

/** Slash commands are actions, not prompts, arguments included (`/costs report 2d`). */
export function isSlashCommand(entry: string): boolean {
	return entry.trimStart().startsWith("/");
}

/** The on-disk list, newest first, commands and junk filtered, capped. */
export function loadHistory(file: string): string[] {
	const parsed = readJson<unknown>(file, []);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((e): e is string => typeof e === "string" && e.trim() !== "" && !isSlashCommand(e)).slice(0, MAX_ENTRIES);
}

/** Merge one entry onto the on-disk list (newest first, deduplicated) and write it back. */
export function persistEntry(file: string, entry: string): void {
	if (!entry.trim() || isSlashCommand(entry)) return;
	const merged = loadHistory(file).filter((e) => e !== entry);
	merged.unshift(entry);
	try {
		writeJsonAtomic(file, merged.slice(0, MAX_ENTRIES));
	} catch {
		// Best-effort; never break the editor over it.
	}
}
