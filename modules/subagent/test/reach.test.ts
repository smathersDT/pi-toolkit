import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalModel, probeReachable, resetReachCache } from "../reach.ts";

test("isLocalModel: provider name or loopback host", () => {
	assert.equal(isLocalModel({ provider: "local", id: "qwen" }), true);
	assert.equal(isLocalModel({ provider: "x", id: "m", baseUrl: "http://127.0.0.1:8081/v1" }), true);
	assert.equal(isLocalModel({ provider: "x", id: "m", baseUrl: "http://localhost:11434/v1" }), true);
	assert.equal(isLocalModel({ provider: "deepseek", id: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" }), false);
	assert.equal(isLocalModel({ provider: "deepseek", id: "deepseek-v4-flash" }), false);
	assert.equal(isLocalModel(undefined), false);
});

test("probeReachable: any HTTP answer is reachable, a refused connection is not, and the answer is cached", async () => {
	resetReachCache();
	let calls = 0;
	const up = async () => {
		calls++;
		return { status: 404 };
	};
	assert.equal(await probeReachable("http://127.0.0.1:1/v1", 500, up, 1000), true);
	assert.equal(await probeReachable("http://127.0.0.1:1/v1", 500, up, 2000), true);
	assert.equal(calls, 1, "cached within 30s");
	resetReachCache();
	const down = async () => {
		throw new Error("ECONNREFUSED");
	};
	assert.equal(await probeReachable("http://127.0.0.1:1/v1", 500, down, 1000), false);
	assert.equal(await probeReachable(undefined, 500, down), true, "no baseUrl: nothing to probe");
});

test("probeReachable: a hanging server times out as unreachable", async () => {
	resetReachCache();
	const hang = (_url: string, init?: { signal?: AbortSignal }) =>
		new Promise<{ status: number }>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		});
	assert.equal(await probeReachable("http://127.0.0.1:2/v1", 50, hang, 1000), false);
});
