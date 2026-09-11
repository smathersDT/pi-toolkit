import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	agentsChip,
	append,
	bgChip,
	contextChip,
	formatCost,
	formatTokens,
	layoutFooter,
	paintChip,
	rightJustify,
	sessionLine,
	shortAge,
	statusChips,
	wrapChips,
} from "../view.ts";
import { stripAnsi } from "../../../core/text.ts";
import { plainTheme } from "../../../test/harness.ts";

const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*` };
const plainWidth = (s: string) => s.replace(/<\/?[a-zA-Z]+>/g, "").length;
const cut = (s: string, w: number) => truncateToWidth(s, w, "");

describe("sessionLine", () => {
	it("shows cost, model and thinking level in its colour", () => {
		const line = sessionLine({ costUsd: 0.0421, modelId: "deepseek-v4-pro", reasoning: true, thinking: "high" }, theme);
		assert.equal(line, "<success>$0.042</success>  <accent>deepseek-v4-pro</accent><dim> · </dim><thinkingHigh>high</thinkingHigh>");
	});
	it("hints the key that cycles the thinking level, next to the level", () => {
		const line = sessionLine({ costUsd: 0, modelId: "claude-opus-5", reasoning: true, thinking: "high", thinkingKey: "shift+tab" }, theme);
		assert.ok(line.includes("<thinkingHigh>high</thinkingHigh><dim> (shift+tab)</dim>"), line);
		const bare = sessionLine({ costUsd: 0, modelId: "claude-opus-5", reasoning: true, thinking: "high" }, theme);
		assert.ok(bare.includes("<thinkingHigh>high</thinkingHigh>") && !bare.includes("("), bare);
		// A model with no thinking to cycle gets no hint about cycling it.
		const flat = sessionLine({ costUsd: 0, modelId: "m", reasoning: false, thinkingKey: "shift+tab" }, theme);
		assert.ok(!flat.includes("shift+tab") && !flat.includes("thinking"), flat);
	});
	it("puts the model's own rates after it, in grey — in/out/cached only", () => {
		const line = sessionLine({ costUsd: 0.01, modelId: "gpt-5.6-sol", reasoning: false, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 } as any }, theme);
		assert.ok(line.includes("<dim> · $2/$10/$0.2</dim>"), line);
	});
	it("says nothing about a model that bills nothing, or when rates are switched off", () => {
		const free = sessionLine({ costUsd: 0, modelId: "local", reasoning: false, cost: { input: 0, output: 0, cacheRead: 0 } }, theme);
		assert.equal(free, "<success>$0</success>  <accent>local</accent>");
		const off = sessionLine({ costUsd: 0, modelId: "m", reasoning: false, cost: undefined }, theme);
		assert.equal(off, "<success>$0</success>  <accent>m</accent>");
	});
	it("formats money, tokens and ages", () => {
		assert.equal(formatCost(0), "$0");
		assert.equal(formatCost(0.0005), "$0.001");
		assert.equal(formatCost(1.5), "$1.50");
		assert.equal(formatTokens(950), "950");
		assert.equal(formatTokens(3_400), "3k");
		assert.equal(formatTokens(200_000), "200k");
		assert.equal(formatTokens(1_000_000), "1M");
		assert.equal(shortAge(12_000), "12s");
		assert.equal(shortAge(2 * 60_000 + 30_000), "2m");
		assert.equal(shortAge(65 * 60_000), "1h 05m");
	});
});

describe("contextChip", () => {
	const usage = (tokens: number | null, contextWindow: number, percent: number | null) => ({ tokens, contextWindow, percent });
	it("reads used/window and the percentage", () => {
		assert.deepEqual(contextChip(usage(31_400, 1_000_000, 3.14)), { label: "ctx", value: "31k/1M 3%", tone: "info" });
		assert.deepEqual(contextChip(usage(150_000, 200_000, 75)), { label: "ctx", value: "150k/200k 75%", tone: "warn" });
	});
	it("colours by fullness: text under 60, warning under 85, error from there", () => {
		assert.equal(contextChip(usage(59_000, 100_000, 59.4))?.tone, "info");
		assert.equal(contextChip(usage(60_000, 100_000, 60))?.tone, "warn");
		assert.equal(contextChip(usage(84_000, 100_000, 84.4))?.tone, "warn");
		assert.equal(contextChip(usage(85_000, 100_000, 85))?.tone, "error");
		assert.equal(contextChip(usage(99_000, 100_000, 99))?.tone, "error");
	});
	it("says ? rather than 0 right after a compaction, and nothing without a window", () => {
		assert.deepEqual(contextChip(usage(null, 128_000, null)), { label: "ctx", value: "?/128k", tone: "info" });
		assert.equal(contextChip(undefined), null);
		assert.equal(contextChip(usage(10, 0, 0)), null);
	});
});

describe("line-two chips", () => {
	it("bg: hidden when idle, counts jobs and ages the oldest", () => {
		const now = 1_000_000;
		assert.equal(bgChip([], now), null);
		assert.deepEqual(bgChip([{ startedAt: now - 12_000 }], now), { label: "bg", value: "1 job 12s", tone: "info" });
		assert.equal(bgChip([{ startedAt: now - 30_000 }, { startedAt: now - 150_000 }], now)?.value, "2 jobs 2m");
	});
	it("agents: from the subagent status, hidden at zero or when absent", () => {
		assert.equal(agentsChip(undefined), null);
		assert.deepEqual(agentsChip("subagent: 2 running"), { label: "agents", value: "2 running", tone: "info" });
		assert.equal(agentsChip("3")?.value, "3 running");
		assert.equal(agentsChip("0 running"), null);
		assert.equal(agentsChip("   "), null);
		assert.equal(agentsChip("idle")?.value, "idle");
	});
});

describe("statusChips", () => {
	it("hides idle states", () => {
		assert.deepEqual(statusChips(new Map()), []);
		assert.deepEqual(statusChips(new Map([["ide", "ide:   "]])), []);
	});
	it("strips a `key:` prefix and keeps the colour on the rest", () => {
		const chips = statusChips(new Map([["ide", "ide: \x1b[32m✓ repo\x1b[0m"], ["other", "hello"]]));
		assert.deepEqual(
			chips.map((c) => [c.label, c.value, c.tone]),
			[
				["ide", "\x1b[32m✓ repo\x1b[0m", "info"],
				["other", "hello", "info"],
			],
		);
		assert.equal(stripAnsi(chips[0].value), "✓ repo");
	});
	it("says off in dim, and hides the keys the footer's own chips cover", () => {
		const chips = statusChips(new Map([["cache", "cache: off"], ["subagent", "2 running"], ["background", "bg: 1 job"], ["permissions", "yolo"]]));
		assert.deepEqual(chips, [{ label: "cache", value: "off", tone: "off" }]);
	});
});

describe("paint / append / wrap", () => {
	it("paints label and value by tone", () => {
		assert.equal(paintChip({ label: "bg", value: "on", tone: "on" }, theme), "<muted>bg</muted> <success>on</success>");
		assert.equal(paintChip({ label: "cache", value: "off", tone: "off" }, theme), "<dim>cache</dim> <dim>off</dim>");
		assert.equal(paintChip({ label: "ide", value: "stale", tone: "warn" }, theme), "<muted>ide</muted> <warning>stale</warning>");
	});
	it("wraps chips at the width, never splitting one", () => {
		const chips = ["aaaa", "bbbb", "cccc", "dddd"];
		assert.deepEqual(wrapChips(chips, 13, plainWidth), ["aaaa  bbbb", "cccc  dddd"]);
		assert.deepEqual(wrapChips(chips, 100, plainWidth), ["aaaa  bbbb  cccc  dddd"]);
		assert.deepEqual(wrapChips(["x".repeat(20)], 10, plainWidth), ["x".repeat(20)]);
	});
	it("appends two spaces on, measuring past the colour, or refuses", () => {
		assert.equal(append("<accent>ab</accent>", "<dim>yz</dim>", 10, plainWidth), "<accent>ab</accent>  <dim>yz</dim>");
		assert.equal(append("", "yz", 4, plainWidth), "yz");
		assert.equal(append("aaaa", "bbbb", 9, plainWidth), null);
		assert.equal(append("aaaa", "bbbb", 10, plainWidth), "aaaa  bbbb");
	});
	it("right-justifies to the width, or refuses", () => {
		assert.equal(rightJustify("<accent>ab</accent>", "yz", 10, plainWidth), "<accent>ab</accent>      yz");
		assert.equal(rightJustify("aaaa", "bbbb", 10, plainWidth), "aaaa  bbbb");
		assert.equal(rightJustify("aaaa", "bbbb", 9, plainWidth), null);
	});
});

describe("layoutFooter (pi-tui widths)", () => {
	const session = sessionLine({ costUsd: 0.042, modelId: "deepseek-v4-pro", reasoning: true, thinking: "high", thinkingKey: "shift+tab", cost: { input: 0.28, output: 0.42, cacheRead: 0.028 } }, plainTheme);
	const context = paintChip(contextChip({ tokens: 31_000, contextWindow: 1_000_000, percent: 3.1 })!, plainTheme);
	const account = paintChip({ label: "balance", value: "$11.09", tone: "info" }, plainTheme);
	const chips = ["bg 1 job 2m", "agents 2 running", "ide ✓ repo"];

	it("lays out the target look at a wide terminal: account flush right, chips on line two", () => {
		const lines = layoutFooter({ session, context, account, chips }, 120, visibleWidth, cut);
		assert.equal(lines.length, 2);
		assert.equal(lines[0].replace(/ {3,}/, " | "), "$0.042  deepseek-v4-pro · high (shift+tab) · $0.28/$0.42/$0.028  ctx 31k/1M 3% | balance $11.09");
		assert.equal(visibleWidth(lines[0]), 120);
		assert.equal(lines[1], "bg 1 job 2m  agents 2 running  ide ✓ repo");
	});
	it("moves the account, then the context chip, to line two as the width shrinks", () => {
		const at80 = layoutFooter({ session, context, account, chips }, 80, visibleWidth, cut);
		assert.equal(at80[0], `${session}  ${context}`);
		assert.ok(at80.slice(1).join("\n").includes("balance $11.09"), at80.join("\n"));
		const at66 = layoutFooter({ session, context, account, chips }, 66, visibleWidth, cut);
		assert.equal(at66[0], session);
		assert.ok(at66[1].startsWith("ctx 31k/1M 3%  bg 1 job 2m"), at66[1]);
		for (const line of [...at80, ...at66]) assert.ok(visibleWidth(line) <= 80, line);
	});
	it("clips every line to the width and never wraps", () => {
		const lines = layoutFooter({ session, context, account, chips }, 30, visibleWidth, cut);
		assert.ok(lines.length >= 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= 30, `${visibleWidth(line)}: ${line}`);
		assert.equal(lines[0], cut(session, 30));
	});
	it("measures display columns, so a wide glyph is never sliced", () => {
		const lines = layoutFooter({ session: "$0  模型名称很长很长很长", chips: ["ide ✓ 项目"] }, 12, visibleWidth, cut);
		for (const line of lines) assert.ok(visibleWidth(line) <= 12, line);
	});
	it("keeps two lines even with nothing on the second", () => {
		assert.deepEqual(layoutFooter({ session: "$0  m", chips: [] }, 40, visibleWidth, cut), ["$0  m", ""]);
	});
});
