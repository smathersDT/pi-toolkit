import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDir } from "../../../core/paths.ts";
import { DAY_MS, HOUR_MS, appendLedger, isDue, ledgerPath, readState, statePath, writeState, type SyncState } from "../state.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "model-sync-state-"));
const at = (iso: string) => Date.parse(iso);

test("isDue: the 24h stamp, with an hour's grace after a failure", () => {
	const now = at("2026-09-10T12:00:00Z");
	const state = (runs: SyncState["runs"]): SyncState => ({ version: 1, runs });
	assert.equal(isDue(state({}), "deepseek", now), true, "never run");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-10T11:00:00Z", attempt: "2026-09-10T11:00:00Z" } }), "deepseek", now), false, "ran an hour ago");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-09T12:00:01Z" } }), "deepseek", now), false, "just under a day");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-09T11:59:59Z" } }), "deepseek", now), true, "over a day");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-08T12:00:00Z", attempt: "2026-09-10T11:50:00Z", error: "offline" } }), "deepseek", now), false, "failed ten minutes ago");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-08T12:00:00Z", attempt: "2026-09-10T10:00:00Z", error: "offline" } }), "deepseek", now), true, "failed two hours ago");
	assert.equal(isDue(state({ deepseek: { ok: "garbage" } }), "deepseek", now), true, "unparseable stamp counts as never");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-10T11:00:00Z" } }), "anthropic", now), true, "stamps are per provider");
	assert.equal(isDue(state({ deepseek: { ok: "2026-09-10T00:00:00Z" } }), "deepseek", now, 6 * HOUR_MS), true, "custom interval");
	assert.equal(DAY_MS, 24 * HOUR_MS);
});

test("readState/writeState round-trip; an invalid DeepSeek block is dropped, a missing file is fresh", () => {
	const dir = fresh();
	assert.deepEqual(readState(dir), { version: 1, runs: {} });
	const state: SyncState = {
		version: 1,
		runs: { deepseek: { ok: "2026-09-10T00:00:00Z", attempt: "2026-09-10T00:00:00Z" } },
		deepseek: {
			fetchedAt: "2026-09-10T00:00:00Z",
			models: { "deepseek-flash": { peak: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 } } },
			schedule: { days: [1, 2, 3, 4, 5], windows: [[60, 240], [360, 600]] },
			applied: "peak",
		},
	};
	writeState(dir, state);
	assert.deepEqual(readState(dir), state);
	assert.equal(statePath(dir), join(dir, "toolkit", "model-sync", "state.json"));

	const broken = structuredClone(state) as any;
	broken.deepseek.models["deepseek-flash"].peak.input = 5000;
	writeFileSync(statePath(dir), JSON.stringify(broken));
	assert.equal(readState(dir).deepseek, undefined);
	assert.deepEqual(readState(dir).runs, state.runs);

	broken.deepseek.models["deepseek-flash"].peak.input = 0.3;
	broken.deepseek.schedule.windows = [[600, 60]];
	writeFileSync(statePath(dir), JSON.stringify(broken));
	assert.equal(readState(dir).deepseek, undefined);

	writeFileSync(statePath(dir), "{ not json");
	assert.deepEqual(readState(dir), { version: 1, runs: {} });
});

test("appendLedger writes one {t, provider, ok, changed, error?} line per call and never throws", () => {
	const dir = fresh();
	ensureDir(dir);
	appendLedger(dir, { provider: "deepseek", ok: true, changed: ["deepseek-v4-flash"] }, new Date("2026-09-10T01:02:03Z"));
	appendLedger(dir, { provider: "anthropic", ok: false, changed: [], error: "HTTP 503" }, new Date("2026-09-10T01:02:04Z"));
	const lines = readFileSync(ledgerPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(lines, [
		{ t: "2026-09-10T01:02:03.000Z", provider: "deepseek", ok: true, changed: ["deepseek-v4-flash"] },
		{ t: "2026-09-10T01:02:04.000Z", provider: "anthropic", ok: false, changed: [], error: "HTTP 503" },
	]);
	assert.doesNotThrow(() => appendLedger(join(dir, "state.json", "impossible"), { provider: "x", ok: true, changed: [] }));
});
