import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cachePolicyFor, rebuildIsExpensive } from "../core/cache-policy.ts";
import { Frame, FrameBottom, FrameTop, frameLines, toLines, windowLines } from "../core/frame.ts";
import { createToolkit, moduleEnabled, moduleLoadsHere, type ToolkitModule } from "../core/kit.ts";
import { Ledger } from "../core/ledger.ts";
import { loadSettings, mergeConfig, saveSettings } from "../core/settings.ts";
import { foldIdenticalLines, formatClock, formatDuration, formatUsd, replayCarriageReturns, stripAnsi, tidyWhitespace } from "../core/text.ts";
import { FakePi, plainTheme, tempAgentDir } from "./harness.ts";

test("frame: header, gutter, collapsed hint and borders fit the width", () => {
	const lines = frameLines("bash", ["git status"], ["a", "b", "c", "d", "e", "f", "g", "h"], "ok", 40, plainTheme, false);
	assert.equal(lines[0], "╭─ BASH ─────");
	assert.equal(lines[1], "│ git status");
	assert.equal(lines[2], "│ ");
	assert.equal(lines[3], "│ a");
	assert.match(lines[9], /^│ … \+2 lines \(.*to expand\)$/);
	assert.equal(lines.length, 10, "no closing border");
	for (const line of lines) assert.ok(visibleWidth(line) <= 40, line);
});

test("frame: expanded shows everything, tail window keeps the end", () => {
	const all = frameLines("read", ["x.ts"], ["1", "2", "3", "4", "5", "6", "7"], "ok", 40, plainTheme, true);
	assert.ok(all.includes("│ 7"));
	assert.ok(!all.some((l) => l.includes("to expand")));
	const w = windowLines(["1", "2", "3", "4", "5", "6", "7", "8"], false, true);
	assert.deepEqual(w.shown, ["3", "4", "5", "6", "7", "8"]);
	assert.equal(w.hidden, 2);
});

test("frame: narrow widths never overflow", () => {
	for (const width of [1, 3, 8, 12]) {
		const lines = new Frame("delegate", ["a very long head line that must be clipped"], { lines: ["body ".repeat(20)], expanded: true }, "running", plainTheme).render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
});

test("frame: top and bottom components update in place", () => {
	const top = new FrameTop("bash", ["ls"], "running", plainTheme);
	assert.equal(top.render(20)[0], "╭─ BASH ──");
	top.update("bash", ["ls -la"], "error");
	assert.equal(top.render(20)[1], "│ ls -la");
	const bottom = new FrameBottom({ lines: ["one"], expanded: false }, plainTheme, ["footer"]);
	const out = bottom.render(20);
	assert.deepEqual(out, ["│ one", "│ footer"]);
});

test("toLines drops trailing blanks and normalises CRLF", () => {
	assert.deepEqual(toLines("a\r\nb\r\n\r\n\r\n"), ["a", "b"]);
});

test("settings: defaults, merge and round trip", () => {
	const dir = tempAgentDir();
	const s = loadSettings();
	assert.deepEqual(s.modules, {});
	s.modules["tool-style"] = false;
	s.compact = { bashCap: 1 };
	saveSettings(s);
	assert.ok(existsSync(join(dir, "toolkit", "settings.json")));
	const again = loadSettings();
	assert.equal(again.modules["tool-style"], false);
	assert.deepEqual(mergeConfig({ a: 1, nested: { x: 1, y: 2 }, list: [1] }, { nested: { y: 3 }, list: [2, 3] }), { a: 1, nested: { x: 1, y: 3 }, list: [2, 3] });
	assert.deepEqual(mergeConfig({ a: 1 }, undefined), { a: 1 });
});

test("kit: module gating by settings and role", () => {
	tempAgentDir();
	const mod: ToolkitModule = { id: "m", label: "M", description: "", default: true, order: 1, child: ["web"], setup() {} };
	assert.equal(moduleEnabled(mod, { modules: {} }), true);
	assert.equal(moduleEnabled(mod, { modules: { m: false } }), false);
	assert.equal(moduleLoadsHere(mod, { isChild: false, role: undefined, depth: 0, maxTurns: undefined, maxTokens: undefined }), true);
	assert.equal(moduleLoadsHere(mod, { isChild: true, role: "web", depth: 1, maxTurns: undefined, maxTokens: undefined }), true);
	assert.equal(moduleLoadsHere(mod, { isChild: true, role: "git", depth: 1, maxTurns: undefined, maxTokens: undefined }), false);
	assert.equal(moduleLoadsHere({ ...mod, child: "never" }, { isChild: true, role: "web", depth: 1, maxTurns: undefined, maxTokens: undefined }), false);
	assert.equal(moduleLoadsHere({ ...mod, child: "always" }, { isChild: true, role: undefined, depth: 1, maxTurns: undefined, maxTokens: undefined }), true);
});

test("kit: tool patches compose and register once", () => {
	tempAgentDir();
	const kit = createToolkit(new FakePi() as any, { modules: {} });
	const seen: string[] = [];
	kit.patchTool("bash", (def) => {
		seen.push("first");
		return { ...def, description: `${def.description} +1` };
	});
	kit.patchTool("bash", (def) => {
		seen.push("second");
		return { ...def, description: `${def.description} +2` };
	});
	const pi = new FakePi();
	kit.flushToolPatches(pi as any);
	assert.deepEqual(seen, ["first", "second"]);
	assert.equal(pi.tools.size, 1);
	assert.match(pi.tools.get("bash")!.description ?? "", / \+1 \+2$/);
	kit.flushToolPatches(pi as any);
	assert.equal(pi.tools.size, 1);
});

test("kit: config merges the settings section over defaults and saves", () => {
	const dir = tempAgentDir();
	const kit = createToolkit(new FakePi() as any, { modules: {}, compact: { bashCap: 5 } });
	assert.deepEqual(kit.config("compact", { bashCap: 1, other: true }), { bashCap: 5, other: true });
	kit.saveConfig("compact", { bashCap: 9 });
	const saved = JSON.parse(readFileSync(join(dir, "toolkit", "settings.json"), "utf8"));
	assert.equal(saved.compact.bashCap, 9);
});

test("cache policy: known routes and overrides", () => {
	assert.equal(cachePolicyFor({ provider: "anthropic", id: "claude-opus-5" }).checkInSeconds, 300);
	assert.equal(cachePolicyFor({ provider: "github-copilot", id: "gpt-5.6-sol" }).checkInSeconds, 300);
	assert.equal(cachePolicyFor({ provider: "openai", id: "gpt-5.6" }).checkInSeconds, 1800);
	assert.equal(cachePolicyFor({ provider: "openai", id: "gpt-4.1" }).checkInSeconds, 300);
	assert.equal(cachePolicyFor({ provider: "openai-codex", id: "gpt-5.6-sol" }).checkInSeconds, 300);
	assert.equal(cachePolicyFor({ provider: "openai-codex", id: "gpt-5.4" }).checkInSeconds, null);
	assert.equal(cachePolicyFor({ provider: "deepseek", id: "deepseek-v4-pro" }).checkInSeconds, null);
	assert.equal(cachePolicyFor(undefined).checkInSeconds, null);
	assert.equal(cachePolicyFor({ provider: "deepseek", id: "deepseek-v4-pro" }, { "deepseek/deepseek-v4-pro": 120 }).checkInSeconds, 120);
	assert.equal(cachePolicyFor({ provider: "anthropic", id: "claude-opus-5" }, { "anthropic/claude-opus-5": 0 }).checkInSeconds, null);
	assert.equal(rebuildIsExpensive({ cost: { input: 5, cacheRead: 0.5 } }), true);
	assert.equal(rebuildIsExpensive({ cost: { input: 1, cacheRead: 0.5 } }), false);
	assert.equal(rebuildIsExpensive(undefined), false);
});

test("text helpers", () => {
	assert.equal(stripAnsi("[31mred[0m plain"), "red plain");
	assert.equal(replayCarriageReturns("10%\r50%\r100% done\nok"), "100% done\nok");
	assert.equal(tidyWhitespace("a  \n\n\n\nb\n\n"), "a\n\nb");
	assert.equal(foldIdenticalLines("x\nx\nx\nx\ny"), "x\n[+3 identical lines]\ny");
	assert.equal(foldIdenticalLines("x\nx\ny"), "x\nx\ny");
	assert.equal(formatDuration(4200), "4.2s");
	assert.equal(formatDuration(64_000), "1m 04s");
	assert.equal(formatClock(3_700_000), "1h 01m");
	assert.equal(formatUsd(0.0123), "$0.012");
	assert.equal(formatUsd(0), "$0");
});

test("ledger report", () => {
	const ledger = new Ledger();
	ledger.add("compact", 10_000, 2_000);
	ledger.add("compact", 5_000, 5_000);
	const report = ledger.report();
	assert.match(report[0], /^compact\s+2×/);
	assert.match(report[1], /total saved/);
});
