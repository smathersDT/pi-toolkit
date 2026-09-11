import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	codexAccount,
	codexProbe,
	copilotAccount,
	copilotDomain,
	copilotProbe,
	daysUntil,
	deepseekAccount,
	deepseekProbe,
	formatMoney,
	LOGIN_EXPIRED,
	monthStartSeconds,
	openaiProbe,
	openaiSpend,
	type ProbeDeps,
	PROBES,
	untilShort,
	windowLabel,
} from "../account.ts";

const NOW = Date.parse("2026-09-01T14:00:00Z");

/** A `fetch` that answers one URL and records what it was asked. */
function stubFetch(status: number, body: unknown) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetch = (async (url: any, init: any) => {
		calls.push({ url: String(url), headers: init?.headers ?? {} });
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: "",
			json: async () => body,
			text: async () => JSON.stringify(body),
		};
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

const deps = (over: Partial<ProbeDeps>): ProbeDeps => ({
	fetch: stubFetch(200, {}).fetch,
	apiKey: async () => undefined,
	credentials: () => undefined,
	env: () => undefined,
	baseUrl: () => undefined,
	...over,
});

describe("probe table", () => {
	it("covers the four providers that publish something, and not anthropic", () => {
		assert.deepEqual(Object.keys(PROBES).sort(), ["deepseek", "github-copilot", "openai", "openai-codex"]);
	});
});

describe("daysUntil", () => {
	it("floors on whole UTC days so it does not flicker through the afternoon", () => {
		assert.equal(daysUntil("2026-09-13", NOW), "12d");
	});
	it("still says today on reset day, hours after that date's midnight", () => {
		assert.equal(daysUntil("2026-09-01", NOW), "today");
		assert.equal(daysUntil("2026-09-02", NOW), "1d");
	});
	it("has nothing to say about a date that has passed or cannot be read", () => {
		assert.equal(daysUntil("2026-08-01", NOW), undefined);
		assert.equal(daysUntil("soon", NOW), undefined);
		assert.equal(daysUntil(undefined, NOW), undefined);
	});
});

describe("copilotAccount", () => {
	const snapshot = (over: Record<string, unknown> = {}, reset = "2026-09-13") => ({
		quota_reset_date: reset,
		quota_snapshots: {
			chat: { unlimited: true },
			premium_interactions: { entitlement: 1500, remaining: 1311, percent_remaining: 87.4, overage_count: 0, overage_permitted: true, unlimited: false, ...over },
		},
	});

	it("reads the premium counter, not the unlimited ones", () => {
		assert.deepEqual(copilotAccount(snapshot(), NOW), { label: "quota", value: "1311/1500 · 12d", tone: "info" });
	});
	it("warns with a fifth left and reddens with a twentieth", () => {
		assert.equal(copilotAccount(snapshot({ remaining: 200, percent_remaining: 13.3 }), NOW)?.tone, "warn");
		assert.equal(copilotAccount(snapshot({ remaining: 40, percent_remaining: 2.7 }), NOW)?.tone, "error");
	});
	it("derives the percentage when the endpoint omits it", () => {
		const q = snapshot({ remaining: 150 }) as any;
		delete q.quota_snapshots.premium_interactions.percent_remaining;
		assert.equal(copilotAccount(q, NOW)?.tone, "warn");
	});
	it("shows what the overage is costing once the entitlement is gone", () => {
		assert.deepEqual(copilotAccount(snapshot({ remaining: 0, percent_remaining: 0, overage_count: 37 }), NOW), { label: "quota", value: "+37 over · 12d", tone: "error" });
	});
	it("keeps the count when overage is refused — that account is simply out", () => {
		assert.equal(copilotAccount(snapshot({ remaining: 0, percent_remaining: 0, overage_count: 4, overage_permitted: false }), NOW)?.value, "0/1500 · 12d");
	});
	it("says ∞ rather than a number for an unlimited plan", () => {
		assert.deepEqual(copilotAccount(snapshot({ unlimited: true }), NOW), { label: "quota", value: "∞", tone: "info" });
	});
	it("drops the reset when the date is missing", () => {
		assert.equal(copilotAccount(snapshot({}, ""), NOW)?.value, "1311/1500");
	});
	it("rounds the fractional counters a per-model multiplier produces", () => {
		assert.equal(copilotAccount(snapshot({ remaining: 1311.67, entitlement: 1500 }), NOW)?.value, "1312/1500 · 12d");
		assert.equal(copilotAccount(snapshot({ remaining: 0, percent_remaining: 0, overage_count: 37.33 }), NOW)?.value, "+37 over · 12d");
	});
	it("is blank rather than wrong for a response that carries no quota", () => {
		assert.equal(copilotAccount({}, NOW), null);
		assert.equal(copilotAccount({ quota_snapshots: { chat: { unlimited: true } } }, NOW), null);
		assert.equal(copilotAccount(undefined, NOW), null);
	});
});

describe("formatMoney", () => {
	it("keeps cents where they matter and drops them where they do not", () => {
		assert.equal(formatMoney(11.09, "USD"), "$11.09");
		assert.equal(formatMoney(1234.56, "USD"), "$1235");
		assert.equal(formatMoney(0, "USD"), "$0.00");
	});
	it("names a currency it has no symbol for", () => {
		assert.equal(formatMoney(40.1, "CNY"), "¥40.10");
		assert.equal(formatMoney(40.1, "SGD"), "SGD 40.10");
	});
});

describe("deepseekAccount", () => {
	const body = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
		is_available: true,
		balance_infos: [{ currency: "USD", total_balance: "11.09", granted_balance: "0.00", topped_up_balance: "11.09", ...over }],
		...extra,
	});

	it("reads the total as a dollar figure", () => {
		assert.deepEqual(deepseekAccount(body()), { label: "balance", value: "$11.09", tone: "info" });
	});
	it("prefers the USD row when the account holds several currencies", () => {
		const multi = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "80.00" }, { currency: "USD", total_balance: "11.09" }] };
		assert.equal(deepseekAccount(multi)?.value, "$11.09");
		assert.equal(deepseekAccount({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "80.00" }] })?.value, "¥80.00");
	});
	it("warns under five dollars and reddens under one", () => {
		assert.equal(deepseekAccount(body({ total_balance: "4.20" }))?.tone, "warn");
		assert.equal(deepseekAccount(body({ total_balance: "0.40" }))?.tone, "error");
	});
	it("says suspended, because the balance keeps reading fine after the account stops working", () => {
		assert.deepEqual(deepseekAccount(body({}, { is_available: false })), { label: "balance", value: "$11.09 suspended", tone: "error" });
	});
	it("treats a blank figure as unknown, not as zero", () => {
		assert.equal(deepseekAccount(body({ total_balance: "" })), null);
		assert.equal(deepseekAccount(body({ total_balance: "   " })), null);
	});
	it("is blank for a response it does not recognise", () => {
		assert.equal(deepseekAccount({ balance_infos: [] }), null);
		assert.equal(deepseekAccount({ balance_infos: [{ currency: "USD" }] }), null);
		assert.equal(deepseekAccount(null), null);
	});
});

describe("copilotProbe", () => {
	it("uses the OAuth token under `refresh`, not the Copilot bearer under `access`", async () => {
		const { fetch, calls } = stubFetch(200, { quota_snapshots: { premium_interactions: { unlimited: true } } });
		await copilotProbe(deps({ fetch, credentials: () => ({ access: "tid=abc;proxy-ep=proxy.individual.githubcopilot.com", refresh: "gho_secret" }) }));
		assert.equal(calls[0].url, "https://api.github.com/copilot_internal/user");
		assert.equal(calls[0].headers.Authorization, "Bearer gho_secret");
	});
	it("asks the enterprise host when the login recorded one", async () => {
		const { fetch, calls } = stubFetch(200, {});
		await copilotProbe(deps({ fetch, credentials: () => ({ refresh: "gho_secret", enterpriseUrl: "acme.ghe.com" }) }));
		assert.equal(calls[0].url, "https://api.acme.ghe.com/copilot_internal/user");
	});
	it("does not call at all without a token", async () => {
		const { fetch, calls } = stubFetch(200, {});
		assert.equal(await copilotProbe(deps({ fetch, credentials: () => ({ access: "tid=abc" }) })), null);
		assert.equal(calls.length, 0);
	});
	it("falls back to COPILOT_GITHUB_TOKEN, pi's other way in", async () => {
		const { fetch, calls } = stubFetch(200, { quota_snapshots: { premium_interactions: { unlimited: true } } });
		const out = await copilotProbe(deps({ fetch, env: (n) => (n === "COPILOT_GITHUB_TOKEN" ? "gho_env" : undefined) }));
		assert.equal(calls[0].headers.Authorization, "Bearer gho_env");
		assert.equal(out?.value, "∞");
	});
	it("throws on a refusal so the poller can count it and back off", async () => {
		const { fetch } = stubFetch(404, { message: "Not Found" });
		await assert.rejects(copilotProbe(deps({ fetch, credentials: () => ({ refresh: "gho_secret" }) })), /404/);
	});
	it("reports a revoked grant as a login to redo", async () => {
		const { fetch } = stubFetch(401, { message: "Bad credentials" });
		assert.deepEqual(await copilotProbe(deps({ fetch, credentials: () => ({ refresh: "gho_secret" }) })), LOGIN_EXPIRED);
	});
});

describe("deepseekProbe", () => {
	it("sends the key pi resolved", async () => {
		const { fetch, calls } = stubFetch(200, { is_available: true, balance_infos: [{ currency: "USD", total_balance: "11.09" }] });
		const out = await deepseekProbe(deps({ fetch, apiKey: async () => "sk-live" }));
		assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
		assert.equal(calls[0].headers.Authorization, "Bearer sk-live");
		assert.equal(out?.value, "$11.09");
	});
	it("does not call at all without a key", async () => {
		const { fetch, calls } = stubFetch(200, {});
		assert.equal(await deepseekProbe(deps({ fetch })), null);
		assert.equal(calls.length, 0);
	});
	it("will not hand a gateway's key to DeepSeek", async () => {
		const { fetch, calls } = stubFetch(200, {});
		assert.equal(await deepseekProbe(deps({ fetch, apiKey: async () => "sk-gateway", baseUrl: () => "my-proxy.internal" })), null);
		assert.equal(await deepseekProbe(deps({ fetch, apiKey: async () => "sk-gateway", baseUrl: () => "" })), null);
		assert.equal(calls.length, 0);
		await deepseekProbe(deps({ fetch, apiKey: async () => "sk-live", baseUrl: () => "api.deepseek.com" }));
		assert.equal(calls.length, 1);
	});
});

describe("copilotDomain", () => {
	it("reduces whatever the login stored to a bare host", () => {
		assert.equal(copilotDomain("acme.ghe.com"), "acme.ghe.com");
		assert.equal(copilotDomain("https://acme.ghe.com"), "acme.ghe.com");
		assert.equal(copilotDomain("https://acme.ghe.com/enterprises/x"), "acme.ghe.com");
	});
	it("falls back to github.com for anything it cannot read", () => {
		assert.equal(copilotDomain(undefined), "github.com");
		assert.equal(copilotDomain(""), "github.com");
		assert.equal(copilotDomain("   "), "github.com");
		assert.equal(copilotDomain(42), "github.com");
	});
});

describe("untilShort / windowLabel", () => {
	it("uses the largest unit that still says something, floored", () => {
		assert.equal(untilShort(45 * 60_000), "45m");
		assert.equal(untilShort(3 * 3_600_000), "3h");
		assert.equal(untilShort(4 * 86_400_000), "4d");
		assert.equal(untilShort(119 * 60_000), "1h");
		assert.equal(untilShort(47 * 3_600_000), "47h");
		assert.equal(untilShort(48 * 3_600_000), "2d");
	});
	it("says now rather than 0m, and nothing for a window already past", () => {
		assert.equal(untilShort(30_000), "now");
		assert.equal(untilShort(-1), undefined);
		assert.equal(untilShort(undefined), undefined);
		assert.equal(untilShort(Number.NaN), undefined);
	});
	it("names a window by the width the plan actually metered it over", () => {
		assert.equal(windowLabel({ limit_window_seconds: 18_000 }, "?"), "5h");
		assert.equal(windowLabel({ limit_window_seconds: 604_800 }, "?"), "7d");
		assert.equal(windowLabel({ window_minutes: 300 }, "?"), "5h");
		assert.equal(windowLabel({ limit_window_seconds: 1800 }, "?"), "30m");
	});
	it("falls back rather than inventing a width", () => {
		assert.equal(windowLabel({}, "5h"), "5h");
		assert.equal(windowLabel({ limit_window_seconds: 0 }, "wk"), "wk");
		assert.equal(windowLabel({ limit_window_seconds: "" }, "wk"), "wk");
		assert.equal(windowLabel(undefined, "wk"), "wk");
	});
});

describe("codexAccount", () => {
	const win = (used: number, inSeconds: number) => ({ used_percent: used, limit_window_seconds: 18_000, reset_after_seconds: inSeconds });
	const week = (used: number, inSeconds: number) => ({ ...win(used, inSeconds), limit_window_seconds: 604_800 });
	const usage = (over: Record<string, unknown> = {}, credits: Record<string, unknown> = { has_credits: false, unlimited: false, balance: "0" }) => ({
		plan_type: "plus",
		rate_limit: { allowed: true, limit_reached: false, primary_window: win(34, 7200), secondary_window: week(12, 4 * 86_400), ...over },
		credits,
	});

	it("shows both windows, each named by its width and carrying its own reset", () => {
		assert.deepEqual(codexAccount(usage(), NOW), { label: "quota", value: "5h 66% · 2h  7d 88% · 4d", tone: "info" });
	});
	it("keeps the windows in wire order and colours by the worse of the two", () => {
		assert.deepEqual(codexAccount(usage({ secondary_window: week(91, 4 * 86_400) }), NOW), { label: "quota", value: "5h 66% · 2h  7d 9% · 4d", tone: "warn" });
		assert.equal(codexAccount(usage({ primary_window: win(97, 60) }), NOW)?.tone, "error");
		assert.equal(codexAccount(usage({ primary_window: win(85, 60) }), NOW)?.tone, "warn");
	});
	it("reads a reset sent as a duration, as an epoch, or as a date", () => {
		const at = (fields: Record<string, unknown>) => usage({ primary_window: { used_percent: 34, ...fields }, secondary_window: undefined });
		assert.equal(codexAccount(at({ reset_after_seconds: 5400 }), NOW)?.value, "5h 66% · 1h");
		assert.equal(codexAccount(at({ reset_at: (NOW + 3_600_000) / 1000 }), NOW)?.value, "5h 66% · 1h");
		assert.equal(codexAccount(at({ resets_at: NOW + 3_600_000 }), NOW)?.value, "5h 66% · 1h");
		assert.equal(codexAccount(at({ resets_at: "2026-09-01T17:00:00Z" }), NOW)?.value, "5h 66% · 3h");
		assert.equal(codexAccount(usage({ primary_window: { used_percent: 34, reset_after_seconds: 3600, reset_at: 0 }, secondary_window: undefined }), NOW)?.value, "5h 66% · 1h");
	});
	it("drops a reset or a window it could not read rather than the whole chip", () => {
		assert.equal(codexAccount(usage({ primary_window: { used_percent: 34 }, secondary_window: undefined }), NOW)?.value, "5h 66%");
		assert.equal(codexAccount(usage({ primary_window: undefined }), NOW)?.value, "7d 88% · 4d");
	});
	it("adds credits only once a window is actually spent, clamping first", () => {
		const credits = { has_credits: true, unlimited: false, balance: "40.00" };
		assert.equal(codexAccount(usage({}, credits), NOW)?.value, "5h 66% · 2h  7d 88% · 4d");
		assert.equal(codexAccount(usage({ primary_window: win(100, 3600) }, credits), NOW)?.value, "5h 0% · 1h  7d 88% · 4d  40 credits");
		assert.equal(codexAccount(usage({ primary_window: win(99.6, 3600) }, credits), NOW)?.value, "5h 0% · 1h  7d 88% · 4d  40 credits");
		assert.equal(codexAccount(usage({ primary_window: win(-5, 3600), secondary_window: undefined }, credits), NOW)?.value, "5h 100% · 1h");
	});
	it("takes the account's own word for having been refused over any percentage", () => {
		const spent = usage({ primary_window: win(0.4, 3600), secondary_window: undefined });
		assert.equal(codexAccount(spent, NOW)?.tone, "info");
		assert.equal(codexAccount({ ...spent, rate_limit: { ...spent.rate_limit, limit_reached: true } }, NOW)?.tone, "error");
		assert.equal(codexAccount({ ...spent, rate_limit: { ...spent.rate_limit, allowed: false } }, NOW)?.tone, "error");
		assert.equal(codexAccount({ ...spent, rate_limit_reached_type: "primary" }, NOW)?.tone, "error");
	});
	it("reports ∞ only for an account with no metered window at all", () => {
		assert.deepEqual(codexAccount({ credits: { unlimited: true } }, NOW), { label: "quota", value: "∞", tone: "info" });
		assert.equal(codexAccount({ rate_limit: { primary_window: { used_percent: "" } }, credits: { unlimited: true } }, NOW), null);
	});
	it("has nothing to say about a body it cannot read", () => {
		assert.equal(codexAccount({ rate_limit: {} }, NOW), null);
		assert.equal(codexAccount({}, NOW), null);
		assert.equal(codexAccount(null, NOW), null);
		assert.equal(codexAccount({ primary: { used_percent: 34 } }, NOW), null);
	});
});

describe("codexProbe", () => {
	const body = { rate_limit: { primary_window: { used_percent: 34 } } };

	it("sends the token pi refreshed, under the headers pi's own Codex requests use", async () => {
		const { fetch, calls } = stubFetch(200, body);
		const out = await codexProbe(deps({ fetch, apiKey: async () => "jwt", credentials: () => ({ access: "jwt", accountId: "acct_1" }) }));
		assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(calls[0].headers.Authorization, "Bearer jwt");
		assert.equal(calls[0].headers["chatgpt-account-id"], "acct_1");
		assert.equal(calls[0].headers.originator, "pi");
		assert.equal(calls[0].headers["User-Agent"], "pi");
		assert.equal(out?.value, "5h 66%");
	});
	it("omits the account header rather than sending an empty one", async () => {
		const { fetch, calls } = stubFetch(200, body);
		await codexProbe(deps({ fetch, apiKey: async () => "jwt", credentials: () => ({ accountId: "" }) }));
		assert.equal("chatgpt-account-id" in calls[0].headers, false);
	});
	it("does not call at all without a token", async () => {
		const { fetch, calls } = stubFetch(200, body);
		assert.equal(await codexProbe(deps({ fetch })), null);
		assert.equal(calls.length, 0);
	});
	it("does not diagnose an expired login from an unavailable key, and keeps transient errors", async () => {
		const { fetch, calls } = stubFetch(200, body);
		await assert.rejects(codexProbe(deps({ fetch, credentials: () => ({ type: "oauth", access: "stale" }) })), /no access token/);
		await assert.rejects(
			codexProbe(
				deps({
					fetch,
					apiKey: async () => {
						throw new Error("refresh timed out");
					},
				}),
			),
			/refresh timed out/,
		);
		assert.equal(calls.length, 0);
	});
	it("reads the account ID after key resolution refreshes the credentials", async () => {
		const { fetch, calls } = stubFetch(200, body);
		let accountId = "old-account";
		await codexProbe(
			deps({
				fetch,
				credentials: () => ({ accountId }),
				apiKey: async () => {
					accountId = "new-account";
					return "new-token";
				},
			}),
		);
		assert.equal(calls[0].headers["chatgpt-account-id"], "new-account");
	});
	it("reports 401 on the refreshed token as login expired, and still throws other refusals", async () => {
		assert.deepEqual(await codexProbe(deps({ fetch: stubFetch(401, { detail: "invalid token" }).fetch, apiKey: async () => "jwt" })), LOGIN_EXPIRED);
		await assert.rejects(codexProbe(deps({ fetch: stubFetch(500, { detail: "upstream" }).fetch, apiKey: async () => "jwt" })), /500/);
	});
	it("will not hand a relay's token to ChatGPT", async () => {
		const { fetch, calls } = stubFetch(200, body);
		assert.equal(await codexProbe(deps({ fetch, apiKey: async () => "jwt", baseUrl: () => "my-relay.internal" })), null);
		assert.equal(await codexProbe(deps({ fetch, apiKey: async () => "jwt", baseUrl: () => "" })), null);
		assert.equal(calls.length, 0);
		await codexProbe(deps({ fetch, apiKey: async () => "jwt", baseUrl: () => "chatgpt.com" }));
		assert.equal(calls.length, 1);
	});
});

describe("openaiSpend / openaiProbe", () => {
	const bucket = (...amounts: number[]) => ({ results: amounts.map((value) => ({ amount: { value, currency: "usd" } })) });
	const admin = (n: string) => (n === "OPENAI_ADMIN_KEY" ? "sk-admin-x" : undefined);

	it("is the first instant of the current UTC month, in seconds", () => {
		assert.equal(monthStartSeconds(NOW), Date.parse("2026-09-01T00:00:00Z") / 1000);
		assert.equal(monthStartSeconds(Date.parse("2026-12-31T23:59:59Z")), Date.parse("2026-12-01T00:00:00Z") / 1000);
	});
	it("sums every daily bucket the month has so far; no spend is $0.00, not no answer", () => {
		assert.deepEqual(openaiSpend({ data: [bucket(1.5, 0.25), bucket(10.65)] }), { label: "spent", value: "$12.40 mtd", tone: "info" });
		assert.deepEqual(openaiSpend({ data: [bucket(), bucket()] }), { label: "spent", value: "$0.00 mtd", tone: "info" });
		assert.equal(openaiSpend({ data: [{ results: [{ amount: { value: 40.1, currency: "eur" } }] }] })?.value, "EUR 40.10 mtd");
	});
	it("refuses a page that was cut short rather than reporting a partial month", () => {
		assert.equal(openaiSpend({ data: [bucket(1.5)], has_more: true }), null);
		assert.equal(openaiSpend({}), null);
		assert.equal(openaiSpend({ data: { results: [] } }), null);
	});
	it("asks for the whole month with the admin key", async () => {
		const { fetch, calls } = stubFetch(200, { data: [{ results: [{ amount: { value: 12.4, currency: "usd" } }] }] });
		const start = monthStartSeconds(Date.now());
		const out = await openaiProbe(deps({ fetch, env: admin }));
		assert.equal(calls[0].url, `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=31`);
		assert.equal(calls[0].headers.Authorization, "Bearer sk-admin-x");
		assert.equal(out?.value, "$12.40 mtd");
	});
	it("never falls back to the model's key, nor spends a refusal on a project/service key", async () => {
		const { fetch, calls } = stubFetch(200, { data: [] });
		assert.equal(await openaiProbe(deps({ fetch, apiKey: async () => "sk-owner" })), null);
		assert.equal(await openaiProbe(deps({ fetch, env: () => "sk-proj-abc" })), null);
		assert.equal(await openaiProbe(deps({ fetch, env: () => "sk-svcacct-abc" })), null);
		assert.equal(calls.length, 0);
	});
	it("will not hand an admin key to a gateway standing in for OpenAI", async () => {
		const { fetch, calls } = stubFetch(200, {});
		assert.equal(await openaiProbe(deps({ fetch, env: admin, baseUrl: () => "openrouter.ai" })), null);
		assert.equal(await openaiProbe(deps({ fetch, env: admin, baseUrl: () => "" })), null);
		assert.equal(calls.length, 0);
	});
});
