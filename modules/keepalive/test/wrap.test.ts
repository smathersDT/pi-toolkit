import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { textOf } from "../../../core/frame.ts";
import { FakePi, makeCtx, renderContext, tempAgentDir } from "../../../test/harness.ts";
import { keepaliveDeadlineMs, KEEPALIVE_DEFAULTS, resetKeepaliveState, runWithKeepalive, state } from "../api.ts";
import module from "../index.ts";

/** Direct Anthropic Claude: 300 s policy, input/cacheRead = 10 → check-ins pay. */
const CACHED_MODEL = { provider: "anthropic", id: "claude-opus-4", reasoning: true, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ok = (text: string) => ({ content: [{ type: "text", text }], details: { from: "work" } });
const slowOk = (text: string, ms: number) => async (signal: AbortSignal | undefined) => {
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(new Error("work aborted"));
		});
	});
	return ok(text);
};

async function setup(model: unknown = CACHED_MODEL) {
	tempAgentDir();
	resetKeepaliveState();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	kit.enabled.add("keepalive");
	const ctx = makeCtx({ model });
	const wait = pi.tools.get("wait")!;
	return { pi, kit, ctx, wait };
}

test("deadline: policy minus margin minus time already spent, floored at 30s", async () => {
	const { kit } = await setup();
	const cfg = { ...KEEPALIVE_DEFAULTS };
	const now = 1_000_000;
	assert.equal(keepaliveDeadlineMs(kit, CACHED_MODEL, cfg, now - 60_000, now).ms, (300 - 45 - 60) * 1000);
	assert.equal(keepaliveDeadlineMs(kit, CACHED_MODEL, cfg, now - 290_000, now).ms, 30_000);
	assert.equal(keepaliveDeadlineMs(kit, { provider: "test", id: "x", cost: CACHED_MODEL.cost }, cfg, now, now).ms, null, "unknown route");
	assert.equal(keepaliveDeadlineMs(kit, { ...CACHED_MODEL, cost: { input: 1, output: 1, cacheRead: 0.9, cacheWrite: 1 } }, cfg, now, now).ms, null, "cheap rebuild");
	assert.equal(keepaliveDeadlineMs(kit, CACHED_MODEL, { ...cfg, ttlOverrides: { "anthropic/claude-opus-4": 0 } }, now, now).ms, null, "override 0 disables");
	kit.enabled.delete("keepalive");
	assert.equal(keepaliveDeadlineMs(kit, CACHED_MODEL, cfg, now, now).ms, null, "module not loaded");
});

test("fast work returns its own result unchanged", async () => {
	const { kit, ctx } = await setup();
	const result = await runWithKeepalive(kit, ctx, { tool: "bash", label: "echo", toolCallId: "1", work: slowOk("hi", 5), deadlineMsOverride: 300 });
	assert.deepEqual(result, ok("hi"));
	assert.equal(state.registry.pending().length, 0, "delivered inline, nothing pending");
});

test("fast failing work rethrows as the tool threw", async () => {
	const { kit, ctx } = await setup();
	await assert.rejects(
		runWithKeepalive(kit, ctx, {
			tool: "bash",
			label: "x",
			toolCallId: "1",
			work: async () => {
				throw new Error("Command exited with code 1");
			},
			deadlineMsOverride: 300,
		}),
		/exited with code 1/,
	);
});

test("slow work detaches at the deadline and wait collects it once", async () => {
	const { kit, ctx, wait } = await setup();
	let detached = false;
	const reply = (await runWithKeepalive(kit, ctx, { tool: "bash", label: "sleep 5", toolCallId: "1", work: slowOk("done", 120), deadlineMsOverride: 20, onDetach: () => (detached = true) })) as any;
	assert.equal(detached, true);
	assert.equal(reply.details.keepalive.running, true);
	assert.equal(reply.details.keepalive.id, "b-1");
	assert.match(textOf(reply), /^\[background\] bash job b-1 still running after \d/);
	assert.match(textOf(reply), /wait\(\{id:"b-1"\}\)/);

	const collected = await wait.execute("2", { id: "b-1" }, undefined, undefined, ctx);
	assert.equal(textOf(collected), "done");
	assert.equal(collected.details.keepalive.status, "done");
	assert.equal(collected.details.from, "work", "the tool's own details survive");
	await assert.rejects(wait.execute("3", { id: "b-1" }, undefined, undefined, ctx), /already collected/);
});

test("background: detaches at once, even with no cache policy, and wait collects it", async () => {
	const { pi, kit, ctx, wait } = await setup({ provider: "test", id: "local", cost: CACHED_MODEL.cost });
	let detached = false;
	let detachedBeforeWork = false;
	const reply = (await runWithKeepalive(kit, ctx, {
		tool: "delegate",
		label: "scout",
		toolCallId: "1",
		background: true,
		onDetach: () => (detached = true),
		work: (s) => {
			detachedBeforeWork = detached;
			return slowOk("report", 40)(s);
		},
	})) as any;
	assert.equal(detachedBeforeWork, true, "onDetach runs before the work can stream partials");
	assert.equal(reply.details.keepalive.running, true);
	assert.match(textOf(reply), /^\[background\] delegate job d-1 started\. .*wait\(\{id:"d-1"\}\)/);
	const collected = await wait.execute("2", { id: "d-1" }, undefined, undefined, ctx);
	assert.equal(textOf(collected), "report");
	await sleep(0);
	assert.equal(pi.sent.length, 0, "collected by wait, so no follow-up");
});

test("background without the keepalive module blocks inline (nothing could collect it)", async () => {
	const { kit, ctx } = await setup();
	kit.enabled.delete("keepalive");
	const result = await runWithKeepalive(kit, ctx, { tool: "delegate", label: "x", toolCallId: "1", background: true, work: slowOk("inline", 5) });
	assert.deepEqual(result, ok("inline"));
	assert.equal(state.registry.all().length, 0);
});

test("no cache policy: the call blocks as before", async () => {
	const { kit, ctx } = await setup({ provider: "test", id: "local", cost: CACHED_MODEL.cost });
	const result = await runWithKeepalive(kit, ctx, { tool: "bash", label: "x", toolCallId: "1", work: slowOk("inline", 40), deadlineMsOverride: 5 });
	assert.deepEqual(result, ok("inline"));
	assert.equal(state.registry.all().length, 0);
});

test("wait without an id collects whichever job finishes first", async () => {
	const { kit, ctx, wait } = await setup();
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "slow", toolCallId: "1", work: slowOk("slow", 150), deadlineMsOverride: 10 });
	await runWithKeepalive(kit, ctx, { tool: "delegate", label: "fast", toolCallId: "2", work: slowOk("fast", 40), deadlineMsOverride: 10 });
	const first = await wait.execute("3", {}, undefined, undefined, ctx);
	assert.equal(textOf(first), "fast");
	assert.equal(first.details.keepalive.id, "d-2");
	const second = await wait.execute("4", {}, undefined, undefined, ctx);
	assert.equal(textOf(second), "slow");
	await assert.rejects(wait.execute("5", {}, undefined, undefined, ctx), /nothing to wait for/);
});

test("wait returns a still-running check-in at its own deadline", async () => {
	const { kit, ctx, wait } = await setup();
	state.deadlineMsOverride = 15;
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "gradle test", toolCallId: "1", work: slowOk("built", 120) });
	const checkIn = await wait.execute("2", { id: "b-1" }, undefined, undefined, ctx);
	assert.equal(checkIn.details.keepalive.running, true);
	assert.match(textOf(checkIn), /bash job b-1 .*still running/);
	assert.match(textOf(checkIn), /gradle test/);
	state.deadlineMsOverride = 2000;
	const done = await wait.execute("3", { id: "b-1" }, undefined, undefined, ctx);
	assert.equal(textOf(done), "built");
});

test("wait stop:true cancels the job", async () => {
	const { kit, ctx, wait } = await setup();
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "forever", toolCallId: "1", work: slowOk("never", 5000), deadlineMsOverride: 10 });
	const stopped = await wait.execute("2", { id: "b-1", stop: true }, undefined, undefined, ctx);
	assert.match(textOf(stopped), /job b-1 stopped after/);
	assert.equal(state.registry.get("b-1")?.status, "cancelled");
	await assert.rejects(wait.execute("3", { id: "b-1" }, undefined, undefined, ctx), /already collected/);
});

test("a job that fails after detaching makes wait throw", async () => {
	const { kit, ctx, wait } = await setup();
	await runWithKeepalive(kit, ctx, {
		tool: "bash",
		label: "x",
		toolCallId: "1",
		work: async () => {
			await sleep(40);
			throw new Error("Command exited with code 2");
		},
		deadlineMsOverride: 10,
	});
	await assert.rejects(wait.execute("2", { id: "b-1" }, undefined, undefined, ctx), /exited with code 2/);
});

test("escape (the tool's signal) cancels a detached job", async () => {
	const { pi, kit, ctx } = await setup();
	const ac = new AbortController();
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "x", toolCallId: "1", work: slowOk("never", 5000), deadlineMsOverride: 10, signal: ac.signal });
	ac.abort();
	await state.registry.get("b-1")!.settled;
	await sleep(0);
	assert.equal(state.registry.get("b-1")?.status, "cancelled");
	assert.equal(pi.sent.length, 0, "a cancelled job never triggers a follow-up turn");
	assert.equal(state.registry.pending().length, 0, "and is not left pending");
});

test("a job finishing while the agent is idle is pushed as a follow-up", async () => {
	const { pi, kit, ctx, wait } = await setup();
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "x", toolCallId: "1", work: slowOk("late result", 30), deadlineMsOverride: 5 });
	await state.registry.get("b-1")!.settled;
	await sleep(0);
	assert.equal(pi.sent.length, 1);
	const { message, options } = pi.sent[0] as { message: any; options: any };
	assert.equal(message.customType, "toolkit-keepalive");
	assert.match(message.content, /^\[background\] job b-1 finished \(bash, .*\):\nlate result$/);
	assert.equal(message.display, true);
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	await assert.rejects(wait.execute("2", { id: "b-1" }, undefined, undefined, ctx), /already collected/);
});

test("a job finishing mid-turn without a wait is delivered at agent_end", async () => {
	const { pi, kit, ctx } = await setup();
	ctx.isIdle = () => false;
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "x", toolCallId: "1", work: slowOk("mid-turn", 30), deadlineMsOverride: 5 });
	await state.registry.get("b-1")!.settled;
	await sleep(0);
	assert.equal(pi.sent.length, 0, "not idle: nothing pushed yet");
	await pi.emit("agent_end", { messages: [] }, ctx);
	assert.equal(pi.sent.length, 1);
	assert.match((pi.sent[0].message as any).content, /mid-turn/);
});

test("a pending wait keeps the settle listener from pushing a follow-up", async () => {
	const { pi, kit, ctx, wait } = await setup();
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "x", toolCallId: "1", work: slowOk("waited", 40), deadlineMsOverride: 5 });
	const collected = await wait.execute("2", { id: "b-1" }, undefined, undefined, ctx);
	assert.equal(textOf(collected), "waited");
	await sleep(0);
	assert.equal(pi.sent.length, 0);
});

test("session_shutdown cancels running jobs", async () => {
	const { pi, kit, ctx } = await setup();
	await runWithKeepalive(kit, ctx, { tool: "bash", label: "x", toolCallId: "1", work: slowOk("never", 5000), deadlineMsOverride: 5 });
	await pi.emit("session_shutdown", { reason: "quit" }, ctx);
	assert.equal(state.registry.get("b-1")?.status, "cancelled");
});

test("the bash patch wraps the built-in tool", async () => {
	const { pi, kit, ctx } = await setup();
	kit.flushToolPatches(pi as any);
	const bash = pi.tools.get("bash");
	assert.ok(bash, "bash registered");
	const result = await bash!.execute("1", { command: "echo keepalive-ok" }, undefined, undefined, ctx);
	assert.match(textOf(result), /keepalive-ok/);
	assert.equal(state.registry.pending().length, 0);
});

test("wait renders in the frame", async () => {
	const { wait, ctx } = await setup();
	const call = wait.renderCall!({ id: "b-1" }, ctx.ui.theme, renderContext({ id: "b-1" })).render(60);
	assert.match(call[0], /^╭─ WAIT ─+$/);
	assert.equal(call[1], "│ b-1");
	const rc = renderContext({ id: "b-1" });
	const result = { content: [{ type: "text", text: "line 1\nline 2" }], details: { keepalive: { id: "b-1", tool: "bash", status: "done", durationMs: 1500 } } };
	const bottom = wait.renderResult!(result, { expanded: false, isPartial: false }, ctx.ui.theme, rc).render(60);
	assert.deepEqual(bottom.slice(0, 2), ["│ line 1", "│ line 2"]);
	assert.match(bottom[2], /bash job b-1 · done · 1\.5s/);
	assert.ok(bottom.every((l) => l.startsWith("│ ")), "no closing border");
	assert.equal((rc.state as any).done, true);
});
