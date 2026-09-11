/**
 * Where the toolkit keeps its files.
 *
 * Everything lives under `<agent-dir>/toolkit/` so a `pi` install with a
 * different PI_CODING_AGENT_DIR gets its own settings, learnings, history and
 * caches, and nothing is written into the extension directory itself (which
 * may be a read-only package checkout).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

declare const __dirname: string | undefined;

/** Resolved lazily: pi exports getAgentDir(), but tests load this file without pi. */
let agentDirOverride: string | undefined;

export function setAgentDir(dir: string | undefined): void {
	agentDirOverride = dir;
}

export function agentDir(): string {
	if (agentDirOverride) return agentDirOverride;
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env && env.trim()) return env;
	return join(homedir(), ".pi", "agent");
}

/** `<agent-dir>/toolkit` — settings, state and caches for this toolkit. */
export function toolkitDir(): string {
	return join(agentDir(), "toolkit");
}

export function toolkitPath(...parts: string[]): string {
	return join(toolkitDir(), ...parts);
}

/** The extension's own root directory (the folder holding index.ts). */
export function extensionRoot(): string {
	try {
		return dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		// jiti in CJS mode provides __dirname instead of import.meta.
		const legacy = (globalThis as { __dirname?: string }).__dirname ?? (typeof __dirname === "string" ? __dirname : undefined);
		return legacy ? dirname(legacy) : process.cwd();
	}
}

export function ensureDir(dir: string): string {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

export function readJson<T>(path: string, fallback: T): T {
	try {
		const raw = readFileSync(path, "utf8");
		if (!raw.trim()) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Write via a temp file + rename so a crash mid-write never leaves a half file. */
export function writeJsonAtomic(path: string, data: unknown): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		// Windows can refuse to rename over an open file; fall back to a direct write.
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		try {
			renameSync(tmp, `${tmp}.gone`);
		} catch {}
	}
}

export function writeTextAtomic(path: string, text: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text, "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		writeFileSync(path, text, "utf8");
	}
}
