import assert from "node:assert/strict";
import { test } from "node:test";
import { centsToPerMillion, copilotBaseUrl, mapCopilotModel, selectable } from "../copilot.ts";
import { DEEPSEEK_ALIASES, anthropicIdMatches, anthropicSlug, currentBand, htmlTable, parseAnthropic, parseDeepSeek, parseOpenAI } from "../parsers.ts";
import { costMoved, money } from "../prices.ts";
import { fixture } from "./helpers.ts";

test("money: page formats in, numbers out, nothing guessed", () => {
	assert.equal(money("$4.00"), 4);
	assert.equal(money("$0.25 / MTok1"), 0.25);
	assert.equal(money("$1 / MTok"), 1);
	assert.equal(money("$15.625"), 15.625);
	assert.equal(money("-", true), 0);
	assert.equal(money("-"), undefined);
	assert.equal(money(""), undefined);
	assert.equal(money("TBD"), undefined);
	assert.equal(money("2x input"), undefined);
	assert.equal(money("4.00"), undefined);
	assert.equal(money("$5000"), undefined);
});

test("costMoved: rates and stated tiers count, key order does not", () => {
	const a = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };
	assert.equal(costMoved({ cacheWrite: 0, cacheRead: 0.1, output: 2, input: 1 }, a), false);
	assert.equal(costMoved({ ...a, tiers: [{ inputTokensAbove: 1, ...a }] }, a), false);
	assert.equal(costMoved({ ...a, tiers: [{ inputTokensAbove: 1, ...a }] }, { ...a, tiers: [] }), true);
	assert.equal(costMoved({ ...a, input: 1.5 }, a), true);
	assert.equal(costMoved(undefined, a), true);
});

test("htmlTable expands row and column spans", () => {
	const grid = htmlTable('<table><tr><td colspan="2">A</td><td>B<sup>(1)</sup></td></tr><tr><td rowspan="2">C</td><td>D</td><td>E</td></tr><tr><td>F</td><td>G</td></tr></table>');
	assert.deepEqual(grid, [
		["A", "A", "B"],
		["C", "D", "E"],
		["C", "F", "G"],
	]);
});

test("deepseek: both bands per model and the UTC schedule", () => {
	const p = parseDeepSeek(fixture("deepseek.html"));
	assert.ok(p);
	assert.deepEqual(p.models["deepseek-flash"].offPeak, { input: 0.15, cacheRead: 0.003, output: 0.6, cacheWrite: 0 });
	assert.deepEqual(p.models["deepseek-flash"].peak, { input: 0.3, cacheRead: 0.006, output: 1.2, cacheWrite: 0 });
	assert.deepEqual(p.models["deepseek-v4-pro"].offPeak, { input: 0.66, cacheRead: 0.022, output: 1.98, cacheWrite: 0 });
	assert.deepEqual(p.models["deepseek-v4-pro"].peak, { input: 1.32, cacheRead: 0.044, output: 3.96, cacheWrite: 0 });
	assert.deepEqual(Object.keys(p.models), ["deepseek-flash", "deepseek-v4-pro"]);
	assert.deepEqual(p.schedule, { days: [1, 2, 3, 4, 5], windows: [[60, 240], [360, 600]] });
	assert.equal(DEEPSEEK_ALIASES["deepseek-v4-flash"], "deepseek-flash");
});

test("deepseek: garbage, a missing price, an absurd price or a changed schedule return undefined", () => {
	const page = fixture("deepseek.html");
	assert.equal(parseDeepSeek("<html><body>maintenance</body></html>"), undefined);
	assert.equal(parseDeepSeek(""), undefined);
	assert.equal(parseDeepSeek(page.replace("$0.022", "")), undefined);
	assert.equal(parseDeepSeek(page.replace("$0.66", "$66000")), undefined);
	assert.equal(parseDeepSeek(page.replace("Monday through Friday", "every day")), undefined);
	assert.equal(parseDeepSeek(page.replace("CACHE HIT", "CACHE READ")), undefined);
});

test("deepseek: band boundaries in UTC, weekends off-peak", () => {
	const schedule = parseDeepSeek(fixture("deepseek.html"))?.schedule;
	assert.ok(schedule);
	const cases: Array<[string, string]> = [
		["2026-09-07T00:59:59Z", "off-peak"],
		["2026-09-07T01:00:00Z", "peak"],
		["2026-09-07T03:59:59Z", "peak"],
		["2026-09-07T04:00:00Z", "off-peak"],
		["2026-09-07T06:00:00Z", "peak"],
		["2026-09-07T10:00:00Z", "off-peak"],
		["2026-09-06T02:00:00Z", "off-peak"],
		["2026-09-12T02:00:00Z", "off-peak"],
	];
	for (const [date, band] of cases) assert.equal(currentBand(schedule, new Date(date)), band, date);
});

test("openai: Standard rows incl. long context; Batch never overwrites; grouped Codex rows added", () => {
	const p = parseOpenAI(fixture("openai.md"));
	assert.ok(p);
	assert.deepEqual(p["gpt-5.6-sol"], { rates: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 }, long: { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 } });
	assert.deepEqual(p["gpt-5.5"], { rates: { input: 5, cacheRead: 0.5, cacheWrite: 0, output: 30 }, long: { input: 10, cacheRead: 1, cacheWrite: 0, output: 45 }, threshold: 272000 });
	assert.deepEqual(p["gpt-5.4-mini"], { rates: { input: 0.75, cacheRead: 0.075, cacheWrite: 0, output: 4.5 } });
	assert.deepEqual(p["gpt-5.4-nano"].rates, { input: 0.2, cacheRead: 0.02, cacheWrite: 0, output: 1.25 });
	assert.equal(p["gpt-5.6-cyber"].rates.input, 12.5);
	assert.equal(p["gpt-5.5-cyber"].rates.cacheWrite, 0);
	assert.equal(p["gpt-5.4-cyber"], undefined);
	assert.equal(Object.keys(p).length, 39);
});

test("openai: garbage, renamed columns or a missing Standard section return undefined", () => {
	const page = fixture("openai.md");
	assert.equal(parseOpenAI("<html>503 Service Unavailable</html>"), undefined);
	assert.equal(parseOpenAI(""), undefined);
	assert.equal(parseOpenAI(page.replace(/Short context input/g, "Input")), undefined);
	assert.equal(parseOpenAI(page.replace("### Standard pricing data", "### Prices")), undefined);
});

test("anthropic: the model pricing table keyed by slug", () => {
	const p = parseAnthropic(fixture("anthropic.md"));
	assert.ok(p);
	assert.deepEqual(p["claude-opus-4-7"], { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 });
	assert.deepEqual(p["claude-fable-5-1"], { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 });
	assert.deepEqual(p["claude-sonnet-5"], { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 });
	assert.deepEqual(p["claude-haiku-4-5"], { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
	assert.deepEqual(p["claude-haiku-3-5"], { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 });
	assert.equal(Object.keys(p).length, 17);
});

test("anthropic: garbage or renamed columns return undefined", () => {
	assert.equal(parseAnthropic("# Pricing\n\nCall sales."), undefined);
	assert.equal(parseAnthropic(""), undefined);
	assert.equal(parseAnthropic(fixture("anthropic.md").replace("Base input tokens", "Input")), undefined);
});

test("anthropic: names map to catalogue ids (exact, dated, legacy order) and never to a sibling", () => {
	assert.equal(anthropicSlug("Claude Opus 4.7"), "claude-opus-4-7");
	assert.equal(anthropicSlug("Claude Sonnet 5"), "claude-sonnet-5");
	assert.equal(anthropicSlug("Claude Mythos 5.1 ([limited availability](https://x))"), "claude-mythos-5-1");
	assert.equal(anthropicSlug("5-minute cache write"), undefined);
	assert.ok(anthropicIdMatches("claude-haiku-4-5", "claude-haiku-4-5"));
	assert.ok(anthropicIdMatches("claude-haiku-4-5", "claude-haiku-4-5-20251001"));
	assert.ok(anthropicIdMatches("claude-haiku-3-5", "claude-3-5-haiku-20241022"));
	assert.ok(!anthropicIdMatches("claude-opus-4", "claude-opus-4-5"));
	assert.ok(!anthropicIdMatches("claude-opus-4-5", "claude-opus-4-5-1"));
	assert.ok(!anthropicIdMatches("claude-sonnet-4", "claude-sonnet-4-6"));
	assert.ok(!anthropicIdMatches("claude-sonnet-4-6", "claude-sonnet-4-5"));
});

test("copilot: rows map to pi entries; unpickable, disabled and absurdly priced rows drop", () => {
	const rows = JSON.parse(fixture("copilot.json")).data;
	const kept = rows.filter(selectable);
	assert.deepEqual(
		kept.map((r: { id: string }) => r.id),
		["claude-sonnet-4.6", "gpt-5.6-sol", "kimi-k3", "bogus-priced"],
	);
	const sonnet = mapCopilotModel(kept[0]);
	assert.ok(sonnet);
	assert.equal(sonnet.api, "anthropic-messages");
	assert.equal(sonnet.reasoning, true);
	assert.deepEqual(sonnet.input, ["text", "image"]);
	assert.equal(sonnet.contextWindow, 1_000_000);
	assert.equal(sonnet.maxTokens, 64_000);
	assert.deepEqual(sonnet.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	assert.deepEqual(sonnet.compat, { forceAdaptiveThinking: true });
	assert.equal(sonnet.thinkingLevelMap?.xhigh, "max");
	assert.equal(sonnet.thinkingLevelMap?.off, null);
	assert.equal(sonnet.thinkingLevelMap?.minimal, "low");

	const sol = mapCopilotModel(kept[1]);
	assert.ok(sol);
	assert.equal(sol.api, "openai-responses");
	assert.deepEqual(sol.cost, { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 });
	assert.equal(sol.thinkingLevelMap?.off, "none");
	assert.equal(sol.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(sol.compat, undefined);

	const kimi = mapCopilotModel(kept[2]);
	assert.ok(kimi);
	assert.equal(kimi.api, "openai-completions");
	assert.equal(kimi.reasoning, true);
	assert.equal(kimi.contextWindow, 128_000, "max_prompt_tokens is a context limit, never borrowed");
	assert.equal(kimi.maxTokens, 16_384);
	assert.deepEqual(kimi.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
	assert.equal(kimi.compat?.thinkingFormat, "deepseek");
	assert.deepEqual(kimi.thinkingLevelMap, { off: null });

	assert.equal(mapCopilotModel(kept[3]), undefined);
	assert.equal(centsToPerMillion(250), 2.5);
	assert.equal(centsToPerMillion(undefined), 0);
	assert.equal(centsToPerMillion(30, 1000), 300);
	assert.equal(copilotBaseUrl("tid=x;proxy-ep=proxy.business.githubcopilot.com;exp=1"), "https://api.business.githubcopilot.com");
	assert.equal(copilotBaseUrl("plain"), "https://api.individual.githubcopilot.com");
});
