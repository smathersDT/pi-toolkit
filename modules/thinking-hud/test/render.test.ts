import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, plainTheme, tempAgentDir } from "../../../test/harness.ts";
import module, { clock, ENTRY_TYPE } from "../index.ts";
import { headline, phaseLabel, type RequestStats, settleDetail, settleLine, settleLines, workingLine } from "../render.ts";

const tagTheme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };

function stats(over: Partial<RequestStats> = {}): RequestStats {
	return {
		totalMs: 41_000,
		thinkingMs: 3_200,
		input: 12_300,
		output: 850,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: 0.012,
		stopReason: "stop",
		hadThinking: true,
		...over,
	};
}

test("settle line is only the request's wall clock", () => {
	assert.equal(settleLine(stats(), plainTheme), "✻ Worked for 41s");
	assert.equal(settleLine(stats({ thinkingMs: 0, hadThinking: false, input: 0, output: 0, costUsd: 0 }), plainTheme), "✻ Worked for 41s");
});

test("bad endings name the wait in their own colour", () => {
	const aborted = settleLine(stats({ stopReason: "aborted", totalMs: 4_200 }), tagTheme);
	assert.equal(aborted, "<warning>✻</warning> <warning>Interrupted after 4.2s</warning>");
	const failed = settleLine(stats({ stopReason: "error", totalMs: 1_100, thinkingMs: 0, hadThinking: false }), tagTheme);
	assert.equal(failed, "<error>✻</error> <error>Failed after 1.1s</error>");
	const length = settleLine(stats({ stopReason: "length", totalMs: 31_000 }), plainTheme);
	assert.equal(length, "✻ Hit the output limit after 31s");
	assert.deepEqual(headline(stats({ stopReason: "toolUse" })), { verb: "", tone: "accent" });
});

test("expanded adds the raw counts on a second line", () => {
	const s = stats({ cacheRead: 10_000 });
	assert.equal(settleDetail(s), "in 12,300 · out 850 · cache read 10,000 · stop stop");
	const lines = settleLines(s, plainTheme, true);
	assert.equal(lines.length, 2);
	assert.equal(lines[1], "  in 12,300 · out 850 · cache read 10,000 · stop stop");
	assert.equal(settleLines(s, plainTheme, false).length, 1);
});

test("working line and phase labels", () => {
	assert.equal(workingLine("Thinking", 12_000, "esc"), "Thinking… 12s   (esc to interrupt)");
	assert.equal(workingLine("Working", 64_000, ""), "Working… 1m 04s");
	assert.equal(phaseLabel("thinking", undefined, []), "Thinking");
	assert.equal(phaseLabel("responding", undefined, []), "Responding");
	assert.equal(phaseLabel("calling", "bash", []), "Calling bash");
	assert.equal(phaseLabel("calling", undefined, []), "Calling tool");
	assert.equal(phaseLabel("running", undefined, ["read"]), "Running read");
	assert.equal(phaseLabel("running", undefined, ["read", "grep", "ls"]), "Running 3 tools");
	assert.equal(phaseLabel("running", undefined, []), "Working");
	assert.equal(phaseLabel("working", undefined, []), "Working");
});

function assistantEvent(type: string, extra: Record<string, unknown> = {}) {
	return { message: { role: "assistant" }, assistantMessageEvent: { type, contentIndex: 0, partial: { content: [] }, ...extra } };
}

function usage(input: number, output: number, cost: number, cacheRead = 0) {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

test("the HUD follows a request from agent_start to the settle line", async () => {
	const agentDir = tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	const ctx = makeCtx();
	let now = 1_000;
	const realNow = clock.now;
	clock.now = () => now;
	try {
		await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		assert.equal(ctx.ui.getHiddenThinkingLabel(), "");
		const indicator = ctx.ui.getWorkingIndicator() as { frames: string[]; intervalMs: number };
		assert.equal(indicator.frames.length, 10);
		assert.equal(indicator.intervalMs, 80);
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(settings.hideThinkingBlock, true);
		assert.equal(ctx.ui.notifications.length, 1);
		assert.match(ctx.ui.notifications[0].message, /hideThinkingBlock/);

		await pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Working… 0s"), ctx.ui.getWorkingMessage());

		now += 12_000;
		await pi.emit("message_update", assistantEvent("thinking_start"), ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Thinking… 12s"), ctx.ui.getWorkingMessage());

		now += 3_200;
		await pi.emit("message_update", assistantEvent("thinking_end", { content: "hmm" }), ctx);
		await pi.emit("message_update", assistantEvent("text_start"), ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Responding… 15s"), ctx.ui.getWorkingMessage());

		await pi.emit("message_update", assistantEvent("toolcall_start", { partial: { content: [{ type: "toolCall", name: "bash" }] } }), ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Calling bash… 15s"), ctx.ui.getWorkingMessage());

		await pi.emit(
			"message_end",
			{ message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], usage: usage(100, 50, 0.001, 1_000), stopReason: "toolUse" } },
			ctx,
		);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Working… 15s"), ctx.ui.getWorkingMessage());

		await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} }, ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Running bash… 15s"), ctx.ui.getWorkingMessage());
		await pi.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} }, ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Running 2 tools… 15s"), ctx.ui.getWorkingMessage());
		await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "1", toolName: "bash", result: {}, isError: false }, ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Running read… 15s"), ctx.ui.getWorkingMessage());
		await pi.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "2", toolName: "read", result: {}, isError: false }, ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Working… 15s"), ctx.ui.getWorkingMessage());

		// A subagent fleet bills on the toolResult, not on any assistant turn.
		await pi.emit("message_end", { message: { role: "toolResult", toolCallId: "1", toolName: "bash", content: [], usage: usage(0, 0, 0.5) } }, ctx);
		await pi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: usage(200, 80, 0.002), stopReason: "stop" } }, ctx);

		now += 1_000;
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(ctx.ui.getWorkingMessage(), undefined);
		assert.equal(pi.entries.length, 1);
		assert.equal(pi.entries[0].customType, ENTRY_TYPE);
		const data = pi.entries[0].data as RequestStats;
		assert.equal(data.totalMs, 16_200);
		assert.equal(data.thinkingMs, 3_200);
		assert.equal(data.input, 300);
		assert.equal(data.output, 130);
		assert.equal(data.cacheRead, 1_000);
		assert.ok(Math.abs(data.costUsd - 0.503) < 1e-9);
		assert.equal(data.stopReason, "stop");
		assert.equal(data.hadThinking, true);

		const render = pi.entryRenderers.get(ENTRY_TYPE);
		assert.ok(render);
		// pi-tui's Text pads rendered lines to the width.
		const lines = render({ customType: ENTRY_TYPE, data }, { expanded: false }, plainTheme).render(120).map((l: string) => l.trimEnd());
		assert.equal(lines[0], "✻ Worked for 16s");
		const expanded = render({ customType: ENTRY_TYPE, data }, { expanded: true }, plainTheme).render(120).map((l: string) => l.trimEnd());
		assert.equal(expanded.length, 2);
		assert.equal(expanded[1], "  in 300 · out 130 · cache read 1,000 · stop stop");
		assert.equal(render({ customType: ENTRY_TYPE, data: undefined }, { expanded: false }, plainTheme), undefined);

		// A second request starts a fresh clock.
		await pi.emit("agent_start", { type: "agent_start" }, ctx);
		assert.ok(ctx.ui.getWorkingMessage()?.startsWith("Working… 0s"), ctx.ui.getWorkingMessage());
		await pi.emit("message_end", { message: { role: "assistant", content: [], usage: usage(1, 1, 0), stopReason: "aborted" } }, ctx);
		await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal((pi.entries[1].data as RequestStats).stopReason, "aborted");
		assert.equal((pi.entries[1].data as RequestStats).input, 1);
	} finally {
		clock.now = realNow;
	}
});

test("settings.json keeps its other keys and is left alone when malformed", async () => {
	const agentDir = tempAgentDir();
	const path = join(agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "dark", hideThinkingBlock: false, nested: { a: 1 } }), "utf8");
	const pi = new FakePi();
	await module.setup(pi as any, createToolkit(pi as any, { modules: {} }));
	const ctx = makeCtx();
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "dark", hideThinkingBlock: true, nested: { a: 1 } });
	assert.equal(ctx.ui.notifications.length, 1);
	// Already on: a reload neither rewrites nor notifies again.
	await pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
	assert.equal(ctx.ui.notifications.length, 1);

	writeFileSync(path, "{ not json", "utf8");
	const pi2 = new FakePi();
	await module.setup(pi2 as any, createToolkit(pi2 as any, { modules: {} }));
	const ctx2 = makeCtx();
	await pi2.emit("session_start", { type: "session_start", reason: "startup" }, ctx2);
	assert.equal(readFileSync(path, "utf8"), "{ not json");
	assert.equal(ctx2.ui.notifications.length, 0);
});

test("hideThinkingText: false leaves settings.json untouched", async () => {
	const agentDir = tempAgentDir();
	const pi = new FakePi();
	await module.setup(pi as any, createToolkit(pi as any, { modules: {}, "thinking-hud": { hideThinkingText: false } }));
	const ctx = makeCtx();
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.equal(existsSync(join(agentDir, "settings.json")), false);
	assert.equal(ctx.ui.getHiddenThinkingLabel(), "");
});

test("outside the TUI nothing is drawn and nothing is appended", async () => {
	tempAgentDir();
	const pi = new FakePi();
	await module.setup(pi as any, createToolkit(pi as any, { modules: {} }));
	const ctx = makeCtx({ mode: "print" });
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	await pi.emit("agent_start", { type: "agent_start" }, ctx);
	assert.equal(ctx.ui.getWorkingMessage(), undefined);
	await pi.emit("message_end", { message: { role: "assistant", content: [], usage: usage(1, 1, 0), stopReason: "stop" } }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	assert.equal(pi.entries.length, 0);
	assert.equal(ctx.ui.getHiddenThinkingLabel(), undefined);
});
