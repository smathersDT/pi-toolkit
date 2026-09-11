import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyModelsJson, mergeCopilotModels, mergeCosts, modelsJsonPath } from "../merge.ts";
import { ledgerPath, readState } from "../state.ts";
import { applyDeepSeekBand, syncProviders } from "../sync.ts";
import { OFF_PEAK, PEAK, fakeFetch, sampleCatalogue } from "./helpers.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "model-sync-merge-"));
const readModels = (dir: string) => JSON.parse(readFileSync(modelsJsonPath(dir), "utf8"));
const backups = (dir: string) => readdirSync(dir).filter((n) => n.startsWith("models.json.bak."));
const ledger = (dir: string) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

test("mergeCosts touches only cost: other providers, headers, overrides and explicit models survive", () => {
	const config = {
		providers: {
			other: { models: [{ id: "keep" }] },
			deepseek: {
				headers: { "X-Keep": "yes" },
				models: [{ id: "deepseek-v4-pro", thinkingLevelMap: { low: "low" }, cost: { input: 9 } }],
				modelOverrides: { "deepseek-v4-pro": { maxTokens: 700, cost: { tiers: [{ inputTokensAbove: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] } } },
			},
		},
	};
	mergeCosts(config, "deepseek", { "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 } });
	const p = config.providers;
	assert.deepEqual(p.other, { models: [{ id: "keep" }] });
	assert.equal(p.deepseek.headers["X-Keep"], "yes");
	assert.equal(p.deepseek.modelOverrides["deepseek-v4-pro"].maxTokens, 700);
	assert.equal(p.deepseek.modelOverrides["deepseek-v4-pro"].cost.input, 0.66);
	assert.equal(p.deepseek.modelOverrides["deepseek-v4-pro"].cost.tiers.length, 1, "tiers the sync did not state are kept");
	assert.deepEqual(p.deepseek.models[0].thinkingLevelMap, { low: "low" });
	assert.equal(p.deepseek.models[0].cost.input, 0.66);
	assert.equal(p.deepseek.models[0].cost.output, 1.98);
	mergeCosts(config, "anthropic", { "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } });
	assert.deepEqual(p.anthropic, { modelOverrides: { "claude-opus-4-7": { cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } } });
	mergeCopilotModels(config, [{ id: "m", name: "m", api: "openai-responses", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
	assert.equal(p["github-copilot"].models.length, 1);
});

test("applyModelsJson: no write when unchanged, backups rotate to three, broken JSON is refused", () => {
	const dir = fresh();
	const set = (input: number) => (c: { providers: Record<string, any> }) => mergeCosts(c, "deepseek", { x: { input, output: 1, cacheRead: 0, cacheWrite: 0 } });
	let r = applyModelsJson(dir, set(1));
	assert.equal(r.written, true);
	assert.equal(backups(dir).length, 0, "nothing to back up on first write");
	const text = readFileSync(modelsJsonPath(dir), "utf8");
	r = applyModelsJson(dir, set(1));
	assert.equal(r.written, false);
	assert.equal(readFileSync(modelsJsonPath(dir), "utf8"), text);
	assert.equal(backups(dir).length, 0);
	for (const v of [2, 3, 4, 5, 6]) assert.equal(applyModelsJson(dir, set(v)).written, true);
	assert.equal(backups(dir).length, 3);
	assert.equal(readModels(dir).providers.deepseek.modelOverrides.x.cost.input, 6);
	const newest = backups(dir).sort().at(-1);
	assert.equal(JSON.parse(readFileSync(join(dir, newest as string), "utf8")).providers.deepseek.modelOverrides.x.cost.input, 5);

	writeFileSync(modelsJsonPath(dir), "{ providers: not json", "utf8");
	r = applyModelsJson(dir, set(7));
	assert.equal(r.written, false);
	assert.match(r.error ?? "", /not valid JSON/);
	assert.equal(readFileSync(modelsJsonPath(dir), "utf8"), "{ providers: not json");

	writeFileSync(modelsJsonPath(dir), '﻿{\n  // a comment pi tolerates\n  "providers": { "deepseek": { "baseUrl": "https://api.deepseek.com" } }\n}\n', "utf8");
	r = applyModelsJson(dir, set(8));
	assert.equal(r.written, true);
	assert.equal(readModels(dir).providers.deepseek.baseUrl, "https://api.deepseek.com");
});

test("syncProviders: every source into one models.json write, ledger and stamps", async () => {
	const dir = fresh();
	const fetchImpl = fakeFetch();
	const out = await syncProviders({ agentDir: dir, catalogue: sampleCatalogue(), providers: ["deepseek", "openai", "openai-codex", "anthropic", "github-copilot"], fetchImpl, now: PEAK, copilotToken: "tok" });
	assert.equal(out.written, true);
	assert.equal(fetchImpl.calls.length, 4, "the OpenAI page is fetched once for openai and openai-codex");
	const by = Object.fromEntries(out.results.map((r) => [r.provider, r]));
	assert.deepEqual(Object.keys(by), ["deepseek", "openai", "openai-codex", "anthropic", "github-copilot"]);
	assert.equal(by.deepseek.ok, true);
	assert.deepEqual(by.deepseek.changed.map((c) => c.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
	assert.equal(by.deepseek.note, "peak band");
	assert.equal(by.openai.matched, 0, "no openai models in the catalogue: nothing invented");
	assert.equal(by["openai-codex"].matched, 2, "spark is not on the page and keeps its price");
	assert.deepEqual(by["openai-codex"].changed.map((c) => c.id), ["gpt-5.6-sol"]);
	assert.equal(by.anthropic.ok, true);
	assert.equal(by.anthropic.matched, 2);
	assert.deepEqual(by.anthropic.changed, []);
	assert.equal(by["github-copilot"].ok, true);
	assert.equal(by["github-copilot"].matched, 3);
	assert.deepEqual(by["github-copilot"].changed, []);
	assert.equal(by["github-copilot"].note, "1 new");

	const p = readModels(dir).providers;
	assert.deepEqual(p.deepseek.modelOverrides["deepseek-v4-flash"].cost, { input: 0.3, cacheRead: 0.006, output: 1.2, cacheWrite: 0 });
	assert.deepEqual(p.deepseek.modelOverrides["deepseek-v4-pro"].cost, { input: 1.32, cacheRead: 0.044, output: 3.96, cacheWrite: 0 });
	assert.deepEqual(p["openai-codex"].modelOverrides["gpt-5.6-sol"].cost, {
		input: 4,
		cacheRead: 0.4,
		cacheWrite: 5,
		output: 20,
		tiers: [{ inputTokensAbove: 272000, input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 }],
	});
	assert.deepEqual(p["openai-codex"].modelOverrides["gpt-5.4-mini"].cost, { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 4.5 });
	assert.equal(p["openai-codex"].modelOverrides["gpt-5.3-codex-spark"], undefined);
	assert.equal(p.openai, undefined);
	assert.deepEqual(p.anthropic.modelOverrides["claude-haiku-4-5-20251001"].cost, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
	assert.deepEqual(
		p["github-copilot"].models.map((m: { id: string }) => m.id),
		["claude-sonnet-4.6", "gpt-5.6-sol", "kimi-k3"],
	);

	const state = readState(dir);
	assert.equal(state.deepseek?.applied, "peak");
	assert.equal(Object.keys(state.deepseek?.models ?? {}).length, 2);
	for (const provider of ["deepseek", "openai", "openai-codex", "anthropic", "github-copilot"]) assert.equal(state.runs[provider]?.ok, PEAK.toISOString(), provider);
	const rows = ledger(dir);
	assert.equal(rows.length, 5);
	assert.deepEqual(rows[0], { t: PEAK.toISOString(), provider: "deepseek", ok: true, changed: ["deepseek-v4-flash", "deepseek-v4-pro"] });

	const again = await syncProviders({ agentDir: dir, catalogue: sampleCatalogue(), providers: ["deepseek", "openai-codex", "anthropic"], fetchImpl, now: PEAK });
	assert.equal(again.written, false, "identical content is not rewritten");
	assert.equal(backups(dir).length, 0);
});

test("syncProviders: a failing source keeps existing prices and the others still land", async () => {
	const dir = fresh();
	const fetchImpl = fakeFetch({
		deepseek: () => {
			throw new Error("offline");
		},
		openai: () => new Response("busy", { status: 503 }),
	});
	const out = await syncProviders({ agentDir: dir, catalogue: sampleCatalogue(), providers: ["deepseek", "openai-codex", "anthropic", "github-copilot"], fetchImpl, now: PEAK });
	const by = Object.fromEntries(out.results.map((r) => [r.provider, r]));
	assert.equal(by.deepseek.ok, false);
	assert.equal(by.deepseek.error, "offline");
	assert.equal(by["openai-codex"].ok, false);
	assert.equal(by["openai-codex"].error, "HTTP 503");
	assert.equal(by.anthropic.ok, true);
	assert.equal(by["github-copilot"].skipped, "no Copilot login in auth.json");
	const p = readModels(dir).providers;
	assert.equal(p.deepseek, undefined);
	assert.equal(p["openai-codex"], undefined);
	assert.ok(p.anthropic.modelOverrides["claude-opus-4-7"]);
	const state = readState(dir);
	assert.equal(state.deepseek, undefined);
	assert.equal(state.runs.deepseek?.ok, undefined);
	assert.equal(state.runs.deepseek?.error, "offline");
	assert.equal(state.runs.anthropic?.ok, PEAK.toISOString());
	assert.equal(ledger(dir).length, 3, "skipped providers are not ledger rows");
	assert.equal(ledger(dir)[0].error, "offline");
});

test("syncProviders: an unrecognised layout or unknown ids write nothing", async () => {
	const dir = fresh();
	const garbage = fakeFetch({ deepseek: () => new Response("<html>new design</html>"), openai: () => new Response("# Pricing\n\nsee our sales team"), anthropic: () => new Response("") });
	const out = await syncProviders({ agentDir: dir, catalogue: sampleCatalogue(), providers: ["deepseek", "openai-codex", "anthropic"], fetchImpl: garbage, now: PEAK });
	assert.ok(out.results.every((r) => !r.ok && /unrecognised page layout/.test(r.error ?? "")));
	assert.equal(existsSync(modelsJsonPath(dir)), false);

	const unknown = await syncProviders({ agentDir: dir, catalogue: [{ provider: "openai-codex", id: "gpt-99-preview", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }], providers: ["openai-codex"], fetchImpl: fakeFetch(), now: PEAK });
	assert.equal(unknown.results[0].ok, true);
	assert.equal(unknown.results[0].matched, 0);
	assert.equal(unknown.written, false);
	assert.equal(existsSync(modelsJsonPath(dir)), false);
});

test("applyDeepSeekBand: rewrites only when the UTC band moved, then is idle", async () => {
	const dir = fresh();
	await syncProviders({ agentDir: dir, catalogue: sampleCatalogue(), providers: ["deepseek"], fetchImpl: fakeFetch(), now: PEAK });
	assert.equal(applyDeepSeekBand(dir, sampleCatalogue(), PEAK), undefined);
	const flip = applyDeepSeekBand(dir, sampleCatalogue(), OFF_PEAK);
	assert.ok(flip);
	assert.equal(flip.band, "off-peak");
	assert.equal(flip.written, true);
	assert.deepEqual(flip.changed.map((c) => `${c.id}:${c.after.input}`), ["deepseek-v4-flash:0.15", "deepseek-v4-pro:0.66"]);
	assert.equal(readModels(dir).providers.deepseek.modelOverrides["deepseek-v4-flash"].cost.input, 0.15);
	assert.equal(readState(dir).deepseek?.applied, "off-peak");
	assert.equal(applyDeepSeekBand(dir, sampleCatalogue(), OFF_PEAK), undefined);
	assert.equal(backups(dir).length, 1);
});
