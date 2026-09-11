import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FRAME_ENTRY, resetFramePrinter } from "../../../core/print.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import { createModelSyncModule, moveLine, resultLine } from "../index.ts";
import { modelsJsonPath } from "../merge.ts";
import { readState } from "../state.ts";
import type { CatalogueModel } from "../sync.ts";
import { OFF_PEAK, PEAK, fakeFetch, sampleCatalogue } from "./helpers.ts";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A fake registry whose refresh() re-reads models.json overrides the way pi does. */
function registry(dir: string, models: Array<CatalogueModel & { cost: any }>, available: string[]) {
	const refreshes: unknown[] = [];
	return {
		refreshes,
		getAll: () => models,
		getAvailable: () => models.filter((m) => available.includes(m.provider)),
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getError: () => undefined,
		refresh: async (options: unknown) => {
			refreshes.push(options);
			if (!existsSync(modelsJsonPath(dir))) return { aborted: false, errors: new Map() };
			const providers = JSON.parse(readFileSync(modelsJsonPath(dir), "utf8")).providers ?? {};
			for (const m of models) {
				const cost = providers[m.provider]?.modelOverrides?.[m.id]?.cost;
				if (cost) m.cost = { ...cost };
			}
			return { aborted: false, errors: new Map() };
		},
	};
}

function host(options: { now?: Date; available?: string[]; fetchImpl?: typeof fetch } = {}) {
	resetFramePrinter();
	const dir = tempAgentDir("model-sync-module-");
	const clock = { now: options.now ?? PEAK };
	const models = sampleCatalogue() as Array<CatalogueModel & { cost: any }>;
	const reg = registry(dir, models, options.available ?? ["deepseek", "openai-codex"]);
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	const module = createModelSyncModule({ fetchImpl: options.fetchImpl ?? fakeFetch(), now: () => clock.now });
	const ctx = makeCtx({ model: models[0] });
	ctx.modelRegistry = reg;
	return { dir, pi, kit, module, ctx, reg, clock, models, frames: () => pi.entries.filter((e) => e.customType === FRAME_ENTRY).map((e) => e.data as any) };
}

test("module contract", () => {
	const module = createModelSyncModule();
	assert.equal(module.id, "model-sync");
	assert.equal(module.order, 80);
	assert.equal(module.child, "never");
	assert.equal(module.default, true);
});

test("/model-sync <provider> prints a frame per provider, refreshes the registry and announces the session's own move", async () => {
	const h = host();
	await h.module.setup(h.pi as any, h.kit);
	await h.pi.commands.get("model-sync")?.handler("deepseek", h.ctx);
	const [frame] = h.frames();
	assert.ok(frame, "a framed report was appended");
	assert.equal(frame.title, "model-sync");
	assert.equal(frame.state, "ok");
	assert.equal(frame.head[0], `models.json: ${modelsJsonPath(h.dir)}`);
	assert.match(frame.head[1], /^written/);
	assert.deepEqual(frame.lines, ["deepseek        updated 2 prices (deepseek-v4-flash, deepseek-v4-pro) — peak band"]);
	assert.deepEqual(h.reg.refreshes, [{ allowNetwork: false }]);
	assert.deepEqual(h.ctx.ui.notifications, [{ message: "deepseek/deepseek-v4-flash price moved: input $0.14 → $0.3, output $0.28 → $1.2, cached $0.0028 → $0.006 per 1M", type: "info" }]);
	assert.equal(h.models[0].cost.input, 0.3, "the fake registry re-read the file");
	assert.equal(readState(h.dir).runs.deepseek?.ok, PEAK.toISOString());

	await h.pi.commands.get("model-sync")?.handler("deepseek", h.ctx);
	const second = h.frames()[1];
	assert.equal(second.head[1], "no changes to write");
	assert.deepEqual(second.lines, ["deepseek        unchanged (2 matched) — peak band"]);
	assert.equal(h.ctx.ui.notifications.length, 1, "nothing moved, nothing said");
});

test("/model-sync with no provider runs the authenticated ones; unknown names and offline are refused", async () => {
	const h = host();
	await h.module.setup(h.pi as any, h.kit);
	const run = h.pi.commands.get("model-sync")?.handler;
	assert.ok(run);
	await run("", h.ctx);
	assert.deepEqual(
		h.frames()[0].lines.map((l: string) => l.split(/\s+/)[0]),
		["deepseek", "openai-codex"],
	);
	await run("nope", h.ctx);
	assert.equal(h.frames()[1].state, "error");
	assert.match(h.frames()[1].lines[0], /unknown provider "nope"/);
	process.env.PI_OFFLINE = "1";
	try {
		await run("anthropic", h.ctx);
	} finally {
		delete process.env.PI_OFFLINE;
	}
	assert.match(h.frames()[2].lines[0], /offline/);
	await run("github-copilot", h.ctx);
	assert.deepEqual(h.frames()[3].lines, ["github-copilot  skipped: no Copilot login in auth.json"]);
	assert.equal(h.frames()[3].state, "ok");
});

test("/model-sync prices lists available models cheapest first", async () => {
	const h = host({ available: ["deepseek", "openai-codex", "anthropic"] });
	await h.module.setup(h.pi as any, h.kit);
	await h.pi.commands.get("model-sync")?.handler("prices", h.ctx);
	const frame = h.frames()[0];
	assert.equal(frame.title, "model-sync prices");
	assert.equal(frame.lines.length, 7);
	assert.match(frame.lines[0], /^deepseek\/deepseek-v4-flash\s+\$0\.14\s+\$0\.0028\s+\$0\.28$/);
	assert.match(frame.lines[6], /^openai-codex\/gpt-5\.6-sol\s+\$5\s+\$0\.5\s+\$30 \+tiers$/);
});

test("session_start syncs due providers in the background once a day, never when switched off", async () => {
	const h = host();
	await h.module.setup(h.pi as any, h.kit);
	process.env.PI_TOOLKIT_MODEL_SYNC = "off";
	try {
		await h.pi.emit("session_start", { reason: "startup" }, h.ctx);
		await wait();
		assert.deepEqual(readState(h.dir).runs, {});
	} finally {
		delete process.env.PI_TOOLKIT_MODEL_SYNC;
	}
	await h.pi.emit("session_start", { reason: "startup" }, h.ctx);
	assert.deepEqual(readState(h.dir).runs, {}, "nothing fetched before the handler returned");
	await wait();
	const runs = readState(h.dir).runs;
	assert.equal(runs.deepseek?.ok, PEAK.toISOString());
	assert.equal(runs["openai-codex"]?.ok, PEAK.toISOString());
	assert.equal(runs.anthropic, undefined, "not authenticated here");
	assert.equal(h.ctx.ui.notifications.length, 1, "the price move of the model in use is announced");
	const fetches = (h.module as any) && h.reg.refreshes.length;
	await h.pi.emit("session_start", { reason: "reload" }, h.ctx);
	await wait();
	assert.equal(h.reg.refreshes.length, fetches, "within 24h nothing runs again");
});

test("before_provider_request re-applies the DeepSeek band when the UTC clock crosses it", async () => {
	const h = host();
	await h.module.setup(h.pi as any, h.kit);
	await h.pi.commands.get("model-sync")?.handler("deepseek", h.ctx);
	h.ctx.ui.notifications.length = 0;
	await h.pi.emit("before_provider_request", { payload: {} }, h.ctx);
	assert.equal(h.reg.refreshes.length, 1, "same band: no work");
	h.clock.now = OFF_PEAK;
	await h.pi.emit("before_provider_request", { payload: {} }, h.ctx);
	assert.equal(JSON.parse(readFileSync(modelsJsonPath(h.dir), "utf8")).providers.deepseek.modelOverrides["deepseek-v4-flash"].cost.input, 0.15);
	assert.equal(readState(h.dir).deepseek?.applied, "off-peak");
	assert.deepEqual(h.ctx.ui.notifications, [{ message: "deepseek/deepseek-v4-flash price moved: input $0.3 → $0.15, output $1.2 → $0.6, cached $0.006 → $0.003 per 1M", type: "info" }]);
	await h.pi.emit("model_select", { model: h.models[0] }, h.ctx);
	assert.equal(h.reg.refreshes.length, 2, "already applied: idle");
});

test("a hook never breaks the session: a broken models.json is reported, not thrown", async () => {
	const h = host();
	await h.module.setup(h.pi as any, h.kit);
	writeFileSync(join(h.dir, "models.json"), "{ broken", "utf8");
	await h.pi.commands.get("model-sync")?.handler("deepseek", h.ctx);
	const frame = h.frames()[0];
	assert.equal(frame.state, "error");
	assert.match(frame.head[1], /^not written: models\.json is not valid JSON/);
	assert.match(frame.lines[0], /failed: models\.json not written/);
	assert.equal(readFileSync(join(h.dir, "models.json"), "utf8"), "{ broken");
});

test("report lines", () => {
	assert.equal(resultLine({ provider: "anthropic", ok: false, changed: [], matched: 0, error: "HTTP 503" }), "anthropic       failed: HTTP 503");
	assert.equal(
		moveLine({ provider: "openai-codex", id: "gpt-5.6-sol", before: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }, after: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } }),
		"openai-codex/gpt-5.6-sol price moved: input $5 → $4, output $30 → $20, cached $0.5 → $0.4, cache write $6.25 → $5 per 1M",
	);
});
