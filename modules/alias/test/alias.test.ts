import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";

async function setup(settings: Record<string, unknown> = {}) {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {}, ...settings });
	await module.setup(pi as any, kit);
	return pi;
}

/** A ctx that records session control calls. */
function controlCtx() {
	const ctx = makeCtx();
	const fresh = makeCtx();
	const calls = { newSession: 0, shutdown: 0 };
	ctx.newSession = async (options?: { withSession?: (c: any) => Promise<void> }) => {
		calls.newSession++;
		await options?.withSession?.(fresh);
		return { cancelled: false };
	};
	ctx.shutdown = () => {
		calls.shutdown++;
	};
	return { ctx, fresh, calls };
}

test("registers /clear, /exit and /q by default", async () => {
	const pi = await setup();
	assert.deepEqual([...pi.commands.keys()].sort(), ["clear", "exit", "q"]);
	assert.match(pi.commands.get("clear")!.description ?? "", /\/new/);
	assert.match(pi.commands.get("q")!.description ?? "", /\/quit/);
});

test("/clear starts a new session and notifies through the fresh ctx", async () => {
	const pi = await setup();
	const { ctx, fresh, calls } = controlCtx();
	await pi.commands.get("clear")!.handler("", ctx);
	assert.equal(calls.newSession, 1);
	assert.equal(calls.shutdown, 0);
	assert.equal(fresh.ui.notifications[0]?.message, "New session started");
});

test("/exit and /q shut pi down", async () => {
	const pi = await setup();
	for (const name of ["exit", "q"]) {
		const { ctx, calls } = controlCtx();
		await pi.commands.get(name)!.handler("", ctx);
		assert.equal(calls.shutdown, 1, name);
		assert.equal(calls.newSession, 0, name);
	}
});

test("configured aliases merge over the defaults; unknown targets are ignored", async () => {
	const pi = await setup({ alias: { aliases: { bye: "quit", foo: "bar", "bad name": "new" } } });
	assert.deepEqual([...pi.commands.keys()].sort(), ["bye", "clear", "exit", "q"]);
	const { ctx, calls } = controlCtx();
	await pi.commands.get("bye")!.handler("", ctx);
	assert.equal(calls.shutdown, 1);
});
