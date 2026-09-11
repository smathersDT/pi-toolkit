import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOGIN_EXPIRED } from "../account.ts";
import type { Account, Probe, ProbeDeps } from "../account.ts";
import { AccountPoller, type PollerDeps, type SessionFacts } from "../poller.ts";

const MINUTE = 60_000;

/**
 * A poller wired to a fake clock and hand-resolved probes. Every probe call parks
 * on a deferred, so a test can hold one in flight across a model switch, a forced
 * refresh and a timer tick.
 */
function harness(probeProviders: string[] = ["deepseek"]) {
	let now = 1_000_000;
	let facts: SessionFacts | undefined = { provider: "deepseek", baseUrl: "https://api.deepseek.com" };
	let staleMessage: string | undefined;
	const calls: Array<{ provider: string; resolve(a: Account | null): void; reject(e: unknown): void }> = [];
	const ticks: Array<() => void> = [];
	let renders = 0;

	const probeFor =
		(provider: string): Probe =>
		(_deps: ProbeDeps) =>
			new Promise<Account | null>((resolve, reject) => {
				calls.push({ provider, resolve, reject });
			});

	const deps: PollerDeps = {
		current: () => {
			if (staleMessage) throw new Error(staleMessage);
			return facts;
		},
		probes: Object.fromEntries(probeProviders.map((p) => [p, probeFor(p)])),
		probeDeps: () => ({ fetch: globalThis.fetch, apiKey: async () => "k", credentials: () => undefined, env: () => undefined, baseUrl: () => undefined }),
		now: () => now,
		setInterval: (fn) => {
			ticks.push(fn);
			return { clear: () => ticks.splice(ticks.indexOf(fn), 1) };
		},
	};

	const poller = new AccountPoller(deps);
	const settle = async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	};
	return {
		poller,
		calls,
		get renders() {
			return renders;
		},
		get timers() {
			return ticks.length;
		},
		attach: () => poller.attach(() => (renders += 1)),
		advance: (ms: number) => {
			now += ms;
		},
		setProvider: (provider: string | undefined, baseUrl = "https://x") => {
			facts = provider ? { provider, baseUrl } : undefined;
		},
		login: (authVersion: string) => {
			if (facts) facts = { ...facts, authVersion };
		},
		killSession: () => {
			facts = undefined;
		},
		goStale: (message = "This extension ctx is stale after session replacement or reload") => {
			staleMessage = message;
		},
		tick: () => ticks.forEach((f) => f()),
		settle,
	};
}

const ACCOUNT: Account = { label: "balance", value: "$11.09", tone: "info" };

describe("attaching", () => {
	it("fetches nothing until a footer is on screen", async () => {
		const h = harness();
		assert.equal(h.poller.isAttached, false);
		h.poller.get();
		await h.poller.pump(true);
		assert.equal(h.calls.length, 0);
		assert.equal(h.timers, 0);

		h.attach();
		assert.equal(h.poller.isAttached, true);
		h.poller.get();
		assert.equal(h.calls.length, 1);
	});
	it("starts exactly one timer however many views attach", () => {
		const h = harness();
		h.attach();
		h.attach();
		h.attach();
		assert.equal(h.timers, 1);
	});
	it("gives the clock back on dispose, and takes it again on the next attach", () => {
		const h = harness();
		h.attach();
		h.poller.dispose();
		assert.equal(h.timers, 0);
		assert.equal(h.poller.isAttached, false);
		h.attach();
		assert.equal(h.timers, 1);
	});
	it("survives a ctx that throws once pi has invalidated it", () => {
		const h = harness();
		h.attach();
		h.goStale();
		assert.doesNotThrow(() => h.tick());
	});
	it("does not turn a stale ctx into an unhandled rejection on the chained path", async () => {
		const h = harness(["deepseek", "github-copilot"]);
		h.attach();
		h.poller.get();
		h.setProvider("github-copilot");
		const chained = h.poller.pump(false);
		h.goStale();
		h.calls[0].resolve(ACCOUNT);
		await assert.doesNotReject(chained);
	});
});

describe("the poll interval", () => {
	it("asks once, then holds for five minutes — measured from the request", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.advance(800);
		h.calls[0].resolve(ACCOUNT);
		await h.settle();
		assert.equal(h.poller.peek(), ACCOUNT);

		h.advance(4 * MINUTE);
		h.tick();
		assert.equal(h.calls.length, 1, "still inside the interval");
		h.advance(MINUTE - 800);
		h.tick();
		assert.equal(h.calls.length, 2, "exactly five minutes after the request went out");
	});
	it("lets a turn jump the queue, but not more than once a minute", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(ACCOUNT);
		await h.settle();

		h.advance(30_000);
		h.poller.pump(true);
		assert.equal(h.calls.length, 1, "under the floor");
		h.advance(40_000);
		h.poller.pump(true);
		assert.equal(h.calls.length, 2, "past the floor, before the interval");
	});
	it("`/footer account` over a live probe waits on it rather than firing a second", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		assert.equal(h.calls.length, 1);

		const waited = h.poller.refresh();
		assert.equal(h.calls.length, 1);
		h.calls[0].resolve(ACCOUNT);
		await waited;
		await h.settle();
		h.poller.get();
		assert.equal(h.calls.length, 1, "and no follow-up on the next render either");
	});
	it("redraws only when the reading actually changed", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(ACCOUNT);
		await h.settle();
		assert.equal(h.renders, 1);

		h.advance(6 * MINUTE);
		h.tick();
		h.calls[1].resolve({ ...ACCOUNT });
		await h.settle();
		assert.equal(h.renders, 1, "same value, no repaint");

		h.advance(6 * MINUTE);
		h.tick();
		h.calls[2].resolve({ ...ACCOUNT, value: "$9.00" });
		await h.settle();
		assert.equal(h.renders, 2);
	});
});

describe("failures", () => {
	const fail = async (h: ReturnType<typeof harness>, message: string) => {
		h.calls[h.calls.length - 1].reject(new Error(message));
		await h.settle();
	};

	it("gives up after three refusals", async () => {
		const h = harness();
		h.attach();
		for (let i = 0; i < 3; i++) {
			h.poller.get();
			await fail(h, "404 Not Found: {}");
			h.advance(6 * MINUTE);
		}
		assert.equal(h.calls.length, 3);
		h.tick();
		assert.equal(h.calls.length, 3, "retired");
	});
	it("keeps retrying a dropped connection, and keeps the previous value on screen", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(ACCOUNT);
		await h.settle();

		for (const message of ["fetch failed", "The operation was aborted due to timeout", "503 Service Unavailable: "]) {
			h.advance(6 * MINUTE);
			h.tick();
			await fail(h, message);
		}
		assert.equal(h.calls.length, 4);
		h.advance(6 * MINUTE);
		h.tick();
		assert.equal(h.calls.length, 5, "still trying");
		assert.equal(h.poller.peek(), ACCOUNT);
		assert.equal(h.poller.error, "503 Service Unavailable: ");
	});
	it("retries a rate limit rather than counting it as a verdict", async () => {
		for (const message of ["429 Too Many Requests: slow down", "403 Forbidden: API rate limit exceeded"]) {
			const h = harness();
			h.attach();
			for (let i = 0; i < 4; i++) {
				h.poller.get();
				await fail(h, message);
				h.advance(6 * MINUTE);
				h.tick();
			}
			assert.ok(h.calls.length >= 4, message);
		}
	});
	it("rechecks a refused login on the normal schedule", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(LOGIN_EXPIRED);
		await h.settle();
		h.advance(6 * MINUTE);
		h.tick();
		assert.equal(h.calls.length, 2, "login status can recover");
		assert.equal(h.poller.peek(), LOGIN_EXPIRED);
		const waited = h.poller.refresh();
		assert.equal(h.calls.length, 2);
		h.calls[1].resolve(ACCOUNT);
		await waited;
		assert.equal(h.poller.peek(), ACCOUNT);
	});
	it("`/footer account` clears a give-up", async () => {
		const h = harness();
		h.attach();
		for (let i = 0; i < 3; i++) {
			h.poller.get();
			await fail(h, "404 Not Found: {}");
			h.advance(6 * MINUTE);
		}
		assert.equal(h.calls.length, 3);
		const waited = h.poller.refresh();
		assert.equal(h.calls.length, 4);
		h.calls[3].resolve(ACCOUNT);
		await waited;
		assert.equal(h.poller.peek(), ACCOUNT);
	});
});

describe("credential changes", () => {
	it("clears an expired chip immediately after login without waiting for the clock", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(LOGIN_EXPIRED);
		await h.settle();
		h.login("new-login");
		assert.equal(h.poller.get(), null);
		assert.equal(h.calls.length, 2);
		h.calls[1].resolve(ACCOUNT);
		await h.settle();
		assert.equal(h.poller.peek(), ACCOUNT);
	});
	it("discards an old login's in-flight refusal and waits for the new account", async () => {
		const h = harness();
		h.attach();
		const waited = h.poller.pump(false);
		h.login("replacement");
		h.calls[0].resolve(LOGIN_EXPIRED);
		await h.settle();
		assert.equal(h.poller.peek(), null);
		assert.equal(h.calls.length, 2);
		h.calls[1].resolve(ACCOUNT);
		await waited;
		assert.equal(h.poller.peek(), ACCOUNT);
	});
	it("resets the failure cap when credentials change", async () => {
		const h = harness();
		h.attach();
		for (let i = 0; i < 3; i++) {
			const waited = h.poller.pump(false);
			h.calls[i].reject(new Error("401 Unauthorized"));
			await waited;
			h.advance(6 * MINUTE);
		}
		h.login("replacement");
		h.poller.get();
		assert.equal(h.calls.length, 4);
	});
	it("drops the previous account when the same provider switches endpoint", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(ACCOUNT);
		await h.settle();
		h.setProvider("deepseek", "https://relay.internal");
		assert.equal(h.poller.get(), null);
		assert.equal(h.calls.length, 2);
	});
	it("does not reuse an expired chip across disposal and reattachment", async () => {
		const h = harness();
		h.attach();
		h.poller.get();
		h.calls[0].resolve(LOGIN_EXPIRED);
		await h.settle();
		h.poller.dispose();
		h.attach();
		assert.equal(h.poller.get(), null);
		assert.equal(h.calls.length, 2);
	});
});

describe("switching model", () => {
	it("drops the old account rather than showing it under a model it does not bill", async () => {
		const h = harness(["deepseek", "github-copilot"]);
		h.attach();
		h.poller.get();
		h.calls[0].resolve(ACCOUNT);
		await h.settle();

		h.setProvider("github-copilot");
		assert.equal(h.poller.get(), null);
		assert.equal(h.calls[1].provider, "github-copilot");
	});
	it("lands nothing from a probe whose provider moved on while it was in flight", async () => {
		const h = harness(["deepseek", "github-copilot"]);
		h.attach();
		h.poller.get();
		assert.equal(h.calls[0].provider, "deepseek");

		h.setProvider("github-copilot");
		h.poller.get();
		h.calls[0].reject(new Error("401 Unauthorized: bad key"));
		await h.settle();
		assert.equal(h.poller.error, undefined);

		const copilot = h.calls.find((c) => c.provider === "github-copilot");
		assert.ok(copilot, "the new provider's probe did start");
		copilot.resolve({ label: "quota", value: "1311/1500", tone: "info" });
		await h.settle();
		assert.equal(h.poller.peek()?.value, "1311/1500");
	});
	it("makes a caller wait for the new provider, not just for the old probe to clear", async () => {
		const h = harness(["deepseek", "github-copilot"]);
		h.attach();
		h.poller.get();
		h.setProvider("github-copilot");

		let done = false;
		const waited = h.poller.refresh().then(() => {
			done = true;
		});
		h.calls[0].resolve(ACCOUNT);
		await h.settle();
		assert.equal(done, false, "still waiting: copilot has not answered yet");

		const copilot = h.calls.find((c) => c.provider === "github-copilot");
		assert.ok(copilot);
		copilot.resolve({ label: "quota", value: "∞", tone: "info" });
		await waited;
		assert.equal(done, true);
		assert.equal(h.poller.peek()?.value, "∞");
	});
	it("carries the detached flag down the chain, so `/footer account` works with the footer off", async () => {
		const h = harness(["deepseek", "github-copilot"]);
		h.attach();
		h.poller.get();
		h.poller.dispose();
		h.setProvider("github-copilot");

		const waited = h.poller.refresh();
		h.calls[0].resolve(ACCOUNT);
		await h.settle();
		const copilot = h.calls.find((c) => c.provider === "github-copilot");
		assert.ok(copilot, "the chained pump must not be stopped by the attach gate");
		copilot.resolve({ label: "quota", value: "∞", tone: "info" });
		await waited;
		assert.equal(h.poller.peek()?.value, "∞");
	});
	it("has nothing to ask for a provider with no probe, and no session", async () => {
		const h = harness(["deepseek"]);
		h.attach();
		h.setProvider("openai");
		await h.poller.pump(true);
		assert.equal(h.calls.length, 0);
		assert.equal(h.poller.get(), null);

		h.killSession();
		await h.poller.pump(true);
		assert.equal(h.calls.length, 0);
	});
});
