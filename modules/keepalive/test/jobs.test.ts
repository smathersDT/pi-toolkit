import assert from "node:assert/strict";
import { test } from "node:test";
import { DEADLINE, JobRegistry, raceDeadline } from "../jobs.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Work that never finishes on its own but rejects when its signal aborts. */
const untilAborted = (signal: AbortSignal) =>
	new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(new Error("work aborted")), { once: true });
	});

test("ids use the tool initial and one shared counter", () => {
	const reg = new JobRegistry();
	const a = reg.start({ tool: "bash", label: "a", run: async () => 1 });
	const b = reg.start({ tool: "delegate", label: "b", run: async () => 2 });
	const c = reg.start({ tool: "bash", label: "c", run: async () => 3 });
	assert.deepEqual([a.id, b.id, c.id], ["b-1", "d-2", "b-3"]);
});

test("a finished job is handed over exactly once", async () => {
	const reg = new JobRegistry();
	const job = reg.start({ tool: "bash", label: "echo", run: async () => ({ content: [{ type: "text", text: "ok" }] }) });
	assert.equal(reg.running().length, 1);
	await job.settled;
	assert.equal(job.status, "done");
	assert.equal(reg.running().length, 0);
	assert.equal(reg.pending().length, 1);
	const first = reg.take<{ content: Array<{ text: string }> }>(job.id);
	assert.equal(first.kind, "delivered");
	if (first.kind === "delivered") assert.equal(first.value?.content[0].text, "ok");
	assert.equal(reg.pending().length, 0);
	assert.equal(reg.take(job.id).kind, "already");
	assert.equal(reg.take("nope").kind, "unknown");
});

test("a rejected job carries its error", async () => {
	const reg = new JobRegistry();
	const job = reg.start({
		tool: "bash",
		label: "x",
		run: async () => {
			throw new Error("boom");
		},
	});
	await job.settled;
	assert.equal(job.status, "error");
	const taken = reg.take(job.id);
	assert.equal(taken.kind, "delivered");
	if (taken.kind === "delivered") assert.equal((taken.error as Error).message, "boom");
});

test("take on a running job says so", () => {
	const reg = new JobRegistry();
	const job = reg.start({ tool: "bash", label: "x", run: untilAborted });
	assert.equal(reg.take(job.id).kind, "running");
	reg.cancelAll();
});

test("cancel aborts the work and settles the job", async () => {
	const reg = new JobRegistry();
	const job = reg.start({ tool: "bash", label: "sleep", run: untilAborted });
	assert.equal(reg.cancel(job.id, "stopped by wait"), true);
	assert.equal(job.status, "cancelled");
	assert.equal(job.abort.signal.aborted, true);
	assert.match((job.error as Error).message, /b-1 stopped by wait/);
	assert.equal(reg.cancel(job.id), false);
	await job.settled;
	assert.equal(job.status, "cancelled");
});

test("the caller's signal cancels the job", async () => {
	const reg = new JobRegistry();
	const ac = new AbortController();
	const job = reg.start({ tool: "bash", label: "sleep", run: untilAborted, signal: ac.signal });
	ac.abort();
	await job.settled;
	assert.equal(job.status, "cancelled");
	assert.match((job.error as Error).message, /aborted/);
});

test("an already aborted signal cancels at once", async () => {
	const reg = new JobRegistry();
	const ac = new AbortController();
	ac.abort();
	const job = reg.start({ tool: "bash", label: "sleep", run: untilAborted, signal: ac.signal });
	await job.settled;
	assert.equal(job.status, "cancelled");
});

test("the hard cap kills a job", async () => {
	const reg = new JobRegistry();
	const job = reg.start({ tool: "bash", label: "forever", run: untilAborted, hardCapMs: 20 });
	await job.settled;
	assert.equal(job.status, "killed");
	assert.match((job.error as Error).message, /hard cap/);
});

test("waitAny resolves with the first job to finish, then with the pending one", async () => {
	const reg = new JobRegistry();
	reg.start({ tool: "bash", label: "slow", run: () => sleep(60).then(() => "slow") });
	const fast = reg.start({ tool: "bash", label: "fast", run: () => sleep(5).then(() => "fast") });
	const first = await reg.waitAny();
	assert.equal(first?.id, fast.id);
	const again = await reg.waitAny();
	assert.equal(again?.id, fast.id, "pending job is returned at once until taken");
	reg.take(fast.id);
	const next = await reg.waitAny();
	assert.equal(next?.label, "slow");
	reg.take(next!.id);
	assert.equal(await reg.waitAny(), undefined);
});

test("onSettle fires once per job and can be unsubscribed", async () => {
	const reg = new JobRegistry();
	const seen: string[] = [];
	const off = reg.onSettle((job) => seen.push(job.id));
	const a = reg.start({ tool: "bash", label: "a", run: async () => 1 });
	await a.settled;
	off();
	const b = reg.start({ tool: "bash", label: "b", run: async () => 2 });
	await b.settled;
	assert.deepEqual(seen, ["b-1"]);
});

test("raceDeadline returns the value, the sentinel, or rethrows", async () => {
	assert.equal(await raceDeadline(sleep(5).then(() => "fast"), 500), "fast");
	assert.equal(await raceDeadline(sleep(200).then(() => "slow"), 10), DEADLINE);
	await assert.rejects(raceDeadline(Promise.reject(new Error("bad")), 500), /bad/);
});
