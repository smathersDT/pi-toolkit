import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchImpl } from "../net.ts";
import { applyDomainFilters, capSnippet, formatSearch, parseDdg, resolveKeys, search, withSiteFilters } from "../search.ts";

const LONG = "word ".repeat(60).trim();

/** DDG /html/ markup as served in September 2026: direct hrefs, plus the older uddg redirect form and an ad. */
const DDG_HTML = `<!DOCTYPE html><html><body><div id="links" class="results">
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://www.typescriptlang.org/docs/">Documentation - TypeScript</a></h2>
    <a class="result__snippet" href="https://www.typescriptlang.org/docs/">The <b>satisfies</b> operator lets you validate a type</a>
  </div>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpost%3Fa%3D1%26b%3D2&amp;rut=abc">Example &amp; Co</a>
  <div class="result__snippet">Snippet two</div>
</div>
<div class="result result--ad">
  <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=bing&amp;u3=x">Sponsored</a>
  <a class="result__snippet" href="#">Buy now</a>
</div>
<div class="result">
  <a class="result__a" href="https://notexample.org/p">Not example</a>
  <a class="result__snippet" href="https://notexample.org/p">${LONG}</a>
</div>
</div></body></html>`;

interface Call {
	url: string;
	init: RequestInit;
}

function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchImpl & { calls: Call[] } {
	const calls: Call[] = [];
	const impl = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		return handler(url, init);
	}) as FetchImpl & { calls: Call[] };
	impl.calls = calls;
	return impl;
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const down = () => new Response("nope", { status: 503 });
const headerOf = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

test("parseDdg: direct and redirect-wrapped hrefs, ads skipped, snippets paired by order and capped", () => {
	const r = parseDdg(DDG_HTML);
	assert.deepEqual(
		r.map((x) => x.url),
		["https://www.typescriptlang.org/docs/", "https://example.org/post?a=1&b=2", "https://notexample.org/p"],
	);
	assert.equal(r[0].title, "Documentation - TypeScript");
	assert.equal(r[0].snippet, "The satisfies operator lets you validate a type");
	assert.equal(r[1].title, "Example & Co");
	assert.equal(r[1].snippet, "Snippet two");
	assert.ok(r[2].snippet.length <= 181 && r[2].snippet.endsWith("…"), r[2].snippet);
	assert.equal(capSnippet("short"), "short");
});

test("search: DuckDuckGo is the keyless floor — POSTs the form, runs queries one at a time, dedupes across queries", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const fetchImpl = fake(async (url) => {
		if (!url.includes("duckduckgo")) return down();
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		inFlight--;
		return html(DDG_HTML);
	});
	const out = await search({ queries: ["typescript satisfies", "ts satisfies operator"], keys: {}, fetchImpl, ddgDelays: [0] });
	assert.equal(out.backend, "ddg");
	assert.equal(out.total, 3);
	assert.equal(out.groups[0].results.length, 3);
	assert.equal(out.groups[1].results.length, 0, "second query only repeats the first");
	assert.equal(maxInFlight, 1);
	const ddg = fetchImpl.calls.filter((c) => c.url.includes("duckduckgo"));
	assert.equal(ddg.length, 2);
	assert.equal(ddg[0].url, "https://html.duckduckgo.com/html/");
	assert.equal(ddg[0].init.method, "POST");
	assert.equal(String(ddg[0].init.body), "q=typescript+satisfies&kl=wt-wt");
	assert.equal(String(ddg[1].init.body), "q=ts+satisfies+operator&kl=wt-wt");
	assert.ok(ddg[0].init.signal instanceof AbortSignal);
	assert.equal(out.attempts.find((a) => a.backend === "exa-mcp")?.ok, false);
});

test("search: a DDG 202 is retried on the ladder, then given up on with a note", async () => {
	let n = 0;
	const retry = fake((url) => (url.includes("duckduckgo") ? (++n === 1 ? html("", 202) : html(DDG_HTML)) : down()));
	const out = await search({ queries: ["q"], keys: {}, fetchImpl: retry, ddgDelays: [0] });
	assert.equal(out.backend, "ddg");
	assert.equal(n, 2);

	const always = fake((url) => (url.includes("duckduckgo") ? html("", 202) : down()));
	const none = await search({ queries: ["q"], keys: {}, fetchImpl: always, ddgDelays: [0, 0] });
	assert.equal(none.backend, undefined);
	assert.equal(none.total, 0);
	assert.equal(always.calls.filter((c) => c.url.includes("duckduckgo")).length, 3);
	assert.match(none.attempts.find((a) => a.backend === "ddg")?.note ?? "", /rate-limiting/);
	assert.match(formatSearch(none), /^No results\.\n/);
});

test("search: recency and count reach DDG as df and the local cap", async () => {
	const fetchImpl = fake((url) => (url.includes("duckduckgo") ? html(DDG_HTML) : down()));
	const out = await search({ queries: ["q"], keys: {}, recency: "month", count: 2, fetchImpl, ddgDelays: [0] });
	assert.equal(out.total, 2);
	assert.equal(String(fetchImpl.calls.find((c) => c.url.includes("duckduckgo"))?.init.body), "q=q&kl=wt-wt&df=m");
	assert.equal(out.attempts[0].note, "exa-mcp: no recency filter");
});

test("search: Brave leads when keyed — key header, count, freshness, ISO-trimmed dates, no other backend touched", async () => {
	const fetchImpl = fake((url) =>
		url.includes("api.search.brave.com")
			? json({
					web: {
						results: [
							{ title: "Brave <b>one</b>", url: "https://a.test/1", description: "First &amp; foremost", age: "2024-05-01T10:00:00" },
							{ title: "Two", url: "https://b.test/2", description: "Second" },
							{ title: "", url: "https://c.test", description: "no title" },
						],
					},
				})
			: down(),
	);
	const out = await search({ queries: ["q"], keys: { brave: "secret" }, recency: "week", count: 5, fetchImpl });
	assert.equal(out.backend, "brave");
	assert.equal(out.total, 2);
	assert.deepEqual(out.groups[0].results[0], { title: "Brave one", url: "https://a.test/1", snippet: "First & foremost", date: "2024-05-01" });
	assert.deepEqual(out.groups[0].results[1], { title: "Two", url: "https://b.test/2", snippet: "Second" });
	assert.equal(fetchImpl.calls.length, 1);
	const u = new URL(fetchImpl.calls[0].url);
	assert.equal(`${u.origin}${u.pathname}`, "https://api.search.brave.com/res/v1/web/search");
	assert.equal(u.searchParams.get("q"), "q");
	assert.equal(u.searchParams.get("count"), "5");
	assert.equal(u.searchParams.get("freshness"), "pw");
	assert.equal(headerOf(fetchImpl.calls[0].init, "X-Subscription-Token"), "secret");
});

test("search: a failing keyed backend falls through to the next and the attempt is noted", async () => {
	const fetchImpl = fake((url) => {
		if (url.includes("brave.com")) return json({ error: "quota" }, 429);
		if (url.includes("duckduckgo")) return html(DDG_HTML);
		return down();
	});
	const out = await search({ queries: ["q"], keys: { brave: "k" }, fetchImpl, ddgDelays: [0] });
	assert.equal(out.backend, "ddg");
	assert.deepEqual(
		out.attempts.map((a) => [a.backend, a.ok]),
		[
			["brave", false],
			["exa-mcp", false],
			["ddg", true],
		],
	);
	assert.match(out.attempts[0].note, /Brave HTTP 429/);
});

test("search: Tavily takes domain filters natively; Serper gets them as site: terms", async () => {
	const tavily = fake((url, init) => {
		if (url !== "https://api.tavily.com/search") return down();
		const body = JSON.parse(String(init.body));
		assert.equal(body.query, "q");
		assert.deepEqual(body.include_domains, ["docs.test"]);
		assert.equal(body.exclude_domains, undefined);
		assert.equal(headerOf(init, "Authorization"), "Bearer tk");
		return json({ results: [{ title: "T", url: "https://docs.test/a", content: "tav", published_date: "2024-01-02" }, { title: "Off", url: "https://other.test/", content: "x" }] });
	});
	const t = await search({ queries: ["q"], keys: { tavily: "tk", serper: "sk" }, allowedDomains: ["docs.test"], fetchImpl: tavily });
	assert.equal(t.backend, "tavily");
	assert.deepEqual(t.groups[0].results, [{ title: "T", url: "https://docs.test/a", snippet: "tav", date: "2024-01-02" }]);

	const serper = fake((url, init) => {
		if (url !== "https://google.serper.dev/search") return down();
		const body = JSON.parse(String(init.body));
		assert.equal(body.q, "q site:docs.test -site:spam.test");
		assert.equal(body.tbs, "qdr:y");
		assert.equal(headerOf(init, "X-API-KEY"), "sk");
		return json({ organic: [{ title: "S", link: "https://docs.test/s", snippet: "ser", date: "Mar 3, 2024" }] });
	});
	const s = await search({ queries: ["q"], keys: { tavily: "tk", serper: "sk" }, allowedDomains: ["docs.test"], blockedDomains: ["spam.test"], recency: "year", fetchImpl: serper });
	assert.equal(s.backend, "serper");
	assert.deepEqual(s.groups[0].results, [{ title: "S", url: "https://docs.test/s", snippet: "ser", date: "Mar 3, 2024" }]);
	assert.equal(s.attempts[0].backend, "tavily");
});

test("search: Exa MCP handshake, session header, SSE frame and prose parsing; skipped when recency is set", async () => {
	const fetchImpl = fake((url, init) => {
		if (!url.includes("mcp.exa.ai")) return down();
		const body = JSON.parse(String(init.body));
		if (body.method === "initialize") {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "mcp-session-id": "sess-1", "content-type": "application/json" } });
		}
		assert.equal(headerOf(init, "mcp-session-id"), "sess-1");
		if (body.method === "notifications/initialized") return new Response("", { status: 202 });
		assert.equal(body.method, "tools/call");
		assert.equal(body.params.name, "web_search_exa");
		assert.equal(body.params.arguments.query, "q");
		const text = [
			"Title: Exa one",
			"URL: https://exa.test/1",
			"Published: 2024-03-04T00:00:00.000Z",
			"Author: N/A",
			"Highlights: first bit",
			"...",
			"second bit",
			"",
			"Title: Exa two",
			"URL: https://exa.test/2",
			"Published: N/A",
			"Highlights: x",
		].join("\n");
		const frame = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } });
		return new Response(`event: message\ndata: ${frame}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	const out = await search({ queries: ["q"], keys: {}, fetchImpl });
	assert.equal(out.backend, "exa-mcp");
	assert.deepEqual(out.groups[0].results, [
		{ title: "Exa one", url: "https://exa.test/1", snippet: "first bit second bit", date: "2024-03-04" },
		{ title: "Exa two", url: "https://exa.test/2", snippet: "x" },
	]);
	assert.equal(fetchImpl.calls.length, 3);

	// The session is reused: a second search makes one call, not three.
	await search({ queries: ["q"], keys: {}, fetchImpl });
	assert.equal(fetchImpl.calls.length, 4);

	const dated = await search({ queries: ["q"], keys: {}, recency: "day", fetchImpl });
	assert.equal(dated.backend, undefined);
	assert.equal(dated.attempts[0].note, "exa-mcp: no recency filter");
});

test("domain filters: label boundaries, subdomains, site: folding, and the query-side fold for DDG", async () => {
	const rs = parseDdg(DDG_HTML);
	assert.deepEqual(
		applyDomainFilters(rs, ["example.org"]).map((r) => r.url),
		["https://example.org/post?a=1&b=2"],
	);
	assert.deepEqual(
		applyDomainFilters(rs, ["TypeScriptLang.org"]).map((r) => r.url),
		["https://www.typescriptlang.org/docs/"],
	);
	assert.deepEqual(
		applyDomainFilters(rs, [], ["example.org"]).map((r) => r.url),
		["https://www.typescriptlang.org/docs/", "https://notexample.org/p"],
	);
	assert.equal(withSiteFilters("q", ["a.test", "www.b.test"], ["c.test"]), "q (site:a.test OR site:b.test) -site:c.test");

	const fetchImpl = fake((url) => (url.includes("duckduckgo") ? html(DDG_HTML) : down()));
	const out = await search({ queries: ["q"], keys: {}, allowedDomains: ["example.org"], fetchImpl, ddgDelays: [0] });
	assert.deepEqual(
		out.groups[0].results.map((r) => r.url),
		["https://example.org/post?a=1&b=2"],
	);
	assert.equal(String(fetchImpl.calls.find((c) => c.url.includes("duckduckgo"))?.init.body), "q=q+site%3Aexample.org&kl=wt-wt");
});

test("formatSearch: numbered compact lines, per-query headers only for several queries, notes when empty", () => {
	const one = formatSearch({
		backend: "ddg",
		total: 2,
		attempts: [],
		groups: [{ query: "q", results: [{ title: "A", url: "https://a.test", snippet: "sa", date: "2024-01-01" }, { title: "B", url: "https://b.test", snippet: "" }] }],
	});
	assert.equal(one, "1. A — https://a.test (2024-01-01)\n   sa\n2. B — https://b.test");
	const two = formatSearch({
		backend: "ddg",
		total: 1,
		attempts: [],
		groups: [{ query: "q1", results: [{ title: "A", url: "https://a.test", snippet: "sa" }] }, { query: "q2", results: [] }],
	});
	assert.equal(two, "## q1\n1. A — https://a.test\n   sa\n\n## q2 (no new results)");
	assert.equal(formatSearch({ total: 0, attempts: [{ backend: "ddg", ok: false, note: "ddg: down" }], groups: [] }), "No results.\nddg: down");
});

test("resolveKeys: env wins over config, blanks are unset", () => {
	assert.deepEqual(resolveKeys({ brave: "cfg", tavily: " " }, { BRAVE_API_KEY: "env", SERPER_API_KEY: "" }), { brave: "env" });
	assert.deepEqual(resolveKeys({ brave: "cfg" }, {}), { brave: "cfg" });
	assert.deepEqual(resolveKeys(undefined, {}), {});
});

test("search: empty queries are rejected; an aborted signal rejects instead of falling through", async () => {
	await assert.rejects(search({ queries: ["  ", ""], keys: {}, fetchImpl: fake(() => html(DDG_HTML)) }), /needs a query/);
	const c = new AbortController();
	c.abort(new Error("stop"));
	await assert.rejects(search({ queries: ["q"], keys: {}, fetchImpl: fake(() => html(DDG_HTML)), signal: c.signal }), /stop/);
});
