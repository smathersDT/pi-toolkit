import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp, clampMaxChars, fetchPage, formatJson } from "../fetch.ts";
import type { FetchImpl } from "../net.ts";

function respond(body: string | Uint8Array, type: string, status = 200, url?: string): Response {
	const res = new Response(body, { status, headers: type ? { "content-type": type } : {} });
	if (url) Object.defineProperty(res, "url", { value: url });
	return res;
}

const serve =
	(body: string | Uint8Array, type: string, status = 200, url?: string): FetchImpl =>
	async () =>
		respond(body, type, status, url);

test("html becomes markdown with the title on top; the final URL after redirects is reported and used for links", async () => {
	const fetchImpl = serve(
		`<html><head><title>Hello</title></head><body><nav>x</nav><main><h1>Hello</h1><p>World <a href="/a">a</a></p></main></body></html>`,
		"text/html; charset=utf-8",
		200,
		"https://final.test/page",
	);
	const page = await fetchPage("https://start.test/", { fetchImpl });
	assert.equal(page.kind, "html");
	assert.equal(page.url, "https://start.test/");
	assert.equal(page.finalUrl, "https://final.test/page");
	assert.equal(page.title, "Hello");
	assert.equal(page.text, "# Hello\n\nWorld [a](https://final.test/a)");
	assert.equal(page.truncated, false);
	assert.equal(page.totalChars, page.text.length);

	const untitled = await fetchPage("https://a.test/", { fetchImpl: serve(`<title>T</title><p>Body</p>`, "text/html") });
	assert.equal(untitled.text, "# T\n\nBody");
});

test("selector keeps one element and says so when it misses", async () => {
	const html = `<body><div id="x"><p>In</p></div><p>Out</p></body>`;
	const hit = await fetchPage("https://a.test/", { fetchImpl: serve(html, "text/html"), selector: "#x" });
	assert.equal(hit.text, "In");
	assert.equal(hit.selectorMatched, true);
	const miss = await fetchPage("https://a.test/", { fetchImpl: serve(html, "text/html"), selector: "article" });
	assert.equal(miss.selectorMatched, false);
	assert.equal(miss.text, '[selector "article" not found; whole page]\n\nIn\n\nOut');
});

test("json: one line when small, one-space indent when large", async () => {
	const small = await fetchPage("https://a.test/j", { fetchImpl: serve('{ "a" : [1, 2], "b": "x" }', "application/json") });
	assert.equal(small.kind, "json");
	assert.equal(small.text, '{"a":[1,2],"b":"x"}');
	const big = { items: Array.from({ length: 80 }, (_, i) => ({ id: i, name: `item-${i}` })) };
	const large = await fetchPage("https://a.test/j", { fetchImpl: serve(JSON.stringify(big), "application/vnd.api+json") });
	assert.equal(large.text, JSON.stringify(big, null, 1));
	assert.ok(large.text.includes('\n  {\n   "id": 0,'), large.text.slice(0, 40));
	assert.equal(formatJson("not json"), "not json");
});

test("text and xml pass through with whitespace tidied; charsets are honoured; untyped html is sniffed", async () => {
	const t = await fetchPage("https://a.test/t", { fetchImpl: serve("a\r\nb  \r\n\r\n\r\n\r\nc", "text/plain") });
	assert.equal(t.kind, "text");
	assert.equal(t.text, "a\nb\n\nc");
	const x = await fetchPage("https://a.test/x", { fetchImpl: serve("<r><i>1</i></r>", "application/xml") });
	assert.equal(x.text, "<r><i>1</i></r>");
	const latin = await fetchPage("https://a.test/l", { fetchImpl: serve(new Uint8Array([99, 97, 102, 0xe9]), "text/plain; charset=iso-8859-1") });
	assert.equal(latin.text, "café");
	// A string body gives Response a default text/plain type; bytes are how an untyped body arrives.
	const bytes = (s: string) => new TextEncoder().encode(s);
	const sniffed = await fetchPage("https://a.test/", { fetchImpl: serve(bytes("<!doctype html><p>Hi</p>"), "") });
	assert.equal(sniffed.kind, "html");
	assert.equal(sniffed.text, "Hi");
	const plain = await fetchPage("https://a.test/", { fetchImpl: serve(bytes("just text"), "application/octet-stream") });
	assert.equal(plain.kind, "text");
	assert.equal(plain.text, "just text");
});

test("refuses PDF, images and binary bodies with a clear message", async () => {
	await assert.rejects(fetchPage("https://a.test/p", { fetchImpl: serve("%PDF-1.7 ...", "application/pdf") }), /PDF not supported/);
	await assert.rejects(fetchPage("https://a.test/f.pdf", { fetchImpl: serve(new TextEncoder().encode("%PDF-1.7"), "") }), /PDF not supported/);
	await assert.rejects(fetchPage("https://a.test/f", { fetchImpl: serve("%PDF-1.7 mislabelled", "text/plain") }), /PDF not supported/);
	await assert.rejects(fetchPage("https://a.test/doc.pdf", { fetchImpl: serve(new TextEncoder().encode("weird"), "application/octet-stream") }), /PDF not supported/);
	await assert.rejects(fetchPage("https://a.test/i", { fetchImpl: serve(new Uint8Array([137, 80, 78, 71]), "image/png") }), /Unsupported content type "image\/png"/);
	await assert.rejects(fetchPage("https://a.test/b", { fetchImpl: serve(new Uint8Array([0, 1, 2, 0]), "application/octet-stream") }), /binary/);
	await assert.rejects(fetchPage("https://a.test/b", { fetchImpl: serve(new Uint8Array([65, 0, 66]), "text/plain") }), /binary/);
});

test("max_chars caps on a line boundary with a note; the floor is 500 and the ceiling 100000", async () => {
	const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
	const page = await fetchPage("https://a.test/t", { fetchImpl: serve(body, "text/plain"), maxChars: 10 });
	assert.equal(page.truncated, true);
	assert.equal(page.totalChars, body.length);
	const note = /\n\[truncated at (\d+) chars of (\d+)\]$/.exec(page.text);
	assert.ok(note, page.text.slice(-80));
	assert.equal(Number(note[2]), body.length);
	const kept = page.text.slice(0, -note[0].length);
	assert.equal(kept.length, Number(note[1]));
	assert.ok(kept.length <= 500 && kept.length > 300, String(kept.length));
	assert.ok(body.startsWith(kept));
	assert.ok(!kept.endsWith("\n"));
	assert.equal(clampMaxChars(undefined), 15000);
	assert.equal(clampMaxChars(1e9), 100000);
	assert.deepEqual(clamp("abc", 3), { text: "abc", truncated: false });
});

test("the byte cap stops reading a streamed body", async () => {
	const chunk = (s: string) => new TextEncoder().encode(s);
	const fetchImpl: FetchImpl = async () =>
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(chunk("12345678"));
					c.enqueue(chunk("ABCDEFGH"));
					c.close();
				},
			}),
			{ status: 200, headers: { "content-type": "text/plain" } },
		);
	const page = await fetchPage("https://a.test/big", { fetchImpl, maxBytes: 8 });
	assert.equal(page.text, "12345678");
});

test("times out through the abort signal, and honours the caller's signal", async () => {
	const hang: FetchImpl = (_url, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
		});
	await assert.rejects(fetchPage("https://a.test/", { fetchImpl: hang, timeoutMs: 20 }), /timed out/);
	const c = new AbortController();
	const pending = fetchPage("https://a.test/", { fetchImpl: hang, signal: c.signal });
	setTimeout(() => c.abort(new Error("user cancelled")), 5);
	await assert.rejects(pending, /user cancelled/);
	const early = new AbortController();
	early.abort(new Error("already"));
	await assert.rejects(fetchPage("https://a.test/", { fetchImpl: hang, signal: early.signal }), /already/);
});

test("bad URLs and HTTP errors are thrown", async () => {
	await assert.rejects(fetchPage("not a url", {}), /Invalid URL/);
	await assert.rejects(fetchPage("ftp://a.test/x", {}), /Only http/);
	await assert.rejects(fetchPage("https://a.test/404", { fetchImpl: serve("nope", "text/html", 404) }), /HTTP 404 for https:\/\/a\.test\/404/);
});
