/**
 * Shared by the model-sync tests: saved page fixtures, a fetch that serves
 * them (never the network), and a small catalogue shaped like pi's.
 */
import { readFileSync } from "node:fs";
import type { CatalogueModel } from "../sync.ts";

export function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export type Source = "deepseek" | "openai" | "anthropic" | "copilot";

export interface FakeFetch {
	(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	calls: string[];
}

/** Serves the fixtures by URL; `overrides` replace one source's response (or throw). */
export function fakeFetch(overrides: Partial<Record<Source, () => Response>> = {}): FakeFetch {
	const calls: string[] = [];
	const files: Record<Source, string> = { deepseek: "deepseek.html", openai: "openai.md", anthropic: "anthropic.md", copilot: "copilot.json" };
	const f = (async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const key: Source | undefined = url.includes("deepseek") ? "deepseek" : url.includes("openai.com") ? "openai" : url.includes("anthropic") ? "anthropic" : url.includes("githubcopilot") ? "copilot" : undefined;
		if (!key) return new Response("not found", { status: 404 });
		const override = overrides[key];
		if (override) return override();
		return new Response(fixture(files[key]), { status: 200, headers: { "Content-Type": key === "copilot" ? "application/json" : "text/plain" } });
	}) as FakeFetch;
	f.calls = calls;
	return f;
}

/** A Monday inside DeepSeek's 01:00–04:00 UTC peak window. */
export const PEAK = new Date("2026-09-07T02:00:00Z");
/** The same Monday, off-peak. */
export const OFF_PEAK = new Date("2026-09-07T05:00:00Z");

export function sampleCatalogue(): CatalogueModel[] {
	return [
		{ provider: "deepseek", id: "deepseek-v4-flash", cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } },
		{ provider: "deepseek", id: "deepseek-v4-pro", cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 } },
		{ provider: "openai-codex", id: "gpt-5.6-sol", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, tiers: [{ inputTokensAbove: 272000, input: 10, output: 60, cacheRead: 1, cacheWrite: 12.5 }] } },
		{ provider: "openai-codex", id: "gpt-5.4-mini", cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },
		{ provider: "openai-codex", id: "gpt-5.3-codex-spark", cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },
		{ provider: "anthropic", id: "claude-opus-4-7", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
		{ provider: "anthropic", id: "claude-haiku-4-5-20251001", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
		{ provider: "github-copilot", id: "gpt-5.6-sol", cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 } },
		{ provider: "github-copilot", id: "claude-sonnet-4.6", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	];
}
