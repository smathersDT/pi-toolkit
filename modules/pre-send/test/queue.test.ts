import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptQueue, summarize } from "../queue.ts";

test("push keeps order, trims, refuses blanks, and ids never repeat", () => {
	const q = new PromptQueue();
	assert.equal(q.push("   "), undefined);
	const a = q.push("  first  ");
	const b = q.push("second");
	assert.equal(a?.text, "first");
	assert.deepEqual(q.list().map((i) => i.id), [a!.id, b!.id]);
	assert.equal(q.size, 2);
	q.drop(1);
	const c = q.push("third");
	assert.ok(c!.id > b!.id, "ids are monotonic");
});

test("drop takes a 1-based position and rejects anything else", () => {
	const q = new PromptQueue();
	q.push("a");
	q.push("b");
	q.push("c");
	assert.equal(q.drop(0), undefined);
	assert.equal(q.drop(4), undefined);
	assert.equal(q.drop(1.5), undefined);
	assert.equal(q.drop(2)?.text, "b");
	assert.deepEqual(q.list().map((i) => i.text), ["a", "c"]);
});

test("pop returns the newest, clear returns everything in order", () => {
	const q = new PromptQueue();
	q.push("a");
	q.push("b");
	assert.equal(q.pop()?.text, "b");
	q.push("c");
	assert.deepEqual(q.clear().map((i) => i.text), ["a", "c"]);
	assert.equal(q.size, 0);
	assert.equal(q.pop(), undefined);
});

test("takeForSend moves the head into flight; requeue puts it back at the head", () => {
	const q = new PromptQueue();
	q.push("a");
	q.push("b");
	const sent = q.takeForSend(5);
	assert.equal(sent?.text, "a");
	assert.equal(sent?.started, false);
	assert.equal(sent?.sentAt, 5);
	assert.equal(q.size, 1);
	q.markStarted();
	assert.equal(q.inFlight?.started, true);
	const back = q.requeueInFlight();
	assert.deepEqual(back, { id: 1, text: "a", queuedAt: back!.queuedAt });
	assert.equal(q.inFlight, undefined);
	assert.deepEqual(q.list().map((i) => i.text), ["a", "b"]);
	assert.equal(q.takeForSend(), q.inFlight);
	q.clearInFlight();
	assert.equal(q.inFlight, undefined);
	assert.equal(new PromptQueue().requeueInFlight(), undefined);
});

test("images ride along only when present", () => {
	const q = new PromptQueue();
	const img = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	assert.equal(q.push("a", [])?.images, undefined);
	assert.deepEqual(q.push("b", [img])?.images, [img]);
});

test("summarize gives the first non-blank line and counts the rest", () => {
	assert.deepEqual(summarize("\n\n  Fix   the\ttests \nthen commit\n\nand push"), { line: "Fix the tests", more: 2 });
	assert.deepEqual(summarize("one line"), { line: "one line", more: 0 });
	assert.deepEqual(summarize("   "), { line: "", more: 0 });
});
