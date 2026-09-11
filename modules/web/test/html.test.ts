import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, htmlToMarkdown } from "../html.ts";

const md = (html: string, options?: Parameters<typeof htmlToMarkdown>[1]) => htmlToMarkdown(html, options).text;

test("headings, paragraphs and inline emphasis; source line wraps are joined", () => {
	const html = `<html><head><title>Doc &amp; Co</title></head><body>
<h1>Title</h1>
<p>The quick
   brown fox.</p>
<h2>Sub &amp; more</h2>
<p>Second <b>bold</b> and <em>it</em>.</p>
</body></html>`;
	const out = htmlToMarkdown(html);
	assert.equal(out.title, "Doc & Co");
	assert.equal(out.text, "# Title\n\nThe quick brown fox.\n\n## Sub & more\n\nSecond **bold** and *it*.");
});

test("lists: unordered, ordered and nested", () => {
	const html = `<ul><li>One</li><li>Two <a href="https://x.test/a">A</a></li><li>Three<ul><li>Nested</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>`;
	assert.equal(md(html), "- One\n- Two [A](https://x.test/a)\n- Three\n  - Nested\n\n1. First\n2. Second");
});

test("code: inline and fenced with language, entities decoded, whitespace kept", () => {
	const html = `<p>Use <code>foo()</code> here.</p><pre><code class="language-ts">const a = 1 &lt; 2;
if (a) {
  run();
}
</code></pre><p>After</p>`;
	assert.equal(md(html), "Use `foo()` here.\n\n```ts\nconst a = 1 < 2;\nif (a) {\n  run();\n}\n```\n\nAfter");
});

test("tables become pipe rows with a header separator", () => {
	const html = `<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Pear &amp; co</td><td>a|b</td></tr></tbody></table>`;
	assert.equal(md(html), "| Name | Qty |\n| --- | --- |\n| Apple | 3 |\n| Pear & co | a\\|b |");
});

test("links resolve against the base URL; bare-URL text, anchors and images are dropped", () => {
	const html = `<p>See <a href="/docs/intro">the intro</a>, <a href="https://x.test/">https://x.test/</a>, <a href="#top">top</a>, <a href="https://x.test/page#sec">here</a> and <img src="a.png" alt="pic">.</p>`;
	assert.equal(md(html, { baseUrl: "https://x.test/page" }), "See [the intro](https://x.test/docs/intro), https://x.test/, top, here and .");
});

test("entities: named, decimal, hex, unknown left alone, and decoded only after tags are gone", () => {
	assert.equal(decodeEntities("&lt;b&gt; &amp; &quot;q&quot; &#169; &#x1F600; &rsquo; &bogus; &#0;"), '<b> & "q" © 😀 ’ &bogus; &#0;');
	assert.equal(md("<p>&lt;script&gt;alert(1)&lt;/script&gt; stays &amp; text</p>"), "<script>alert(1)</script> stays & text");
});

test("script, style, noscript, svg and page chrome are removed with their bodies", () => {
	const html = `<head><script>var x = "<p>not me</p>";</script><style>p{color:red}</style></head>
<body><nav><a href="/">Home</a></nav><header><h1>Site</h1></header>
<main><p>Body</p></main>
<aside>Side</aside><footer>Foot</footer><noscript>NS</noscript>
<svg><title>icon</title><path d="M0"/></svg><!-- comment --></body>`;
	const out = htmlToMarkdown(html);
	assert.equal(out.title, undefined);
	assert.equal(out.text, "Body");
});

test("selector keeps one element: main, article, #id; a miss falls back to the whole page", () => {
	const html = `<body><nav>Nav</nav><div id="content"><div>Inside</div><div>Deep</div></div><main><p>Main text</p></main><article><header><h2>Head</h2></header><p>Art</p></article><p>Outside</p></body>`;
	assert.deepEqual(htmlToMarkdown(html, { selector: "main" }), { title: undefined, text: "Main text", scoped: true });
	assert.equal(md(html, { selector: "#content" }), "Inside\n\nDeep");
	assert.equal(md(html, { selector: "article" }), "## Head\n\nArt");
	const miss = htmlToMarkdown(html, { selector: "#missing" });
	assert.equal(miss.scoped, false);
	assert.equal(miss.text, "Inside\n\nDeep\n\nMain text\n\nArt\n\nOutside");
});

test("hard breaks, rules, block quotes and blank-line collapsing", () => {
	assert.equal(md("<p>line1<br>line2</p>\n\n\n\n<hr>\n<blockquote><p>Quoted</p><p>twice</p></blockquote><p>a</p><p></p><p>b</p>"), "line1\nline2\n\n---\n\n> Quoted twice\n\na\n\nb");
});

test("unclosed drop elements swallow the rest, as a browser would; nested same-tag drops are balanced", () => {
	assert.equal(md("<p>Keep</p><aside>x<aside>y</aside>z</aside><p>Also</p>"), "Keep\n\nAlso");
	assert.equal(md("<p>Keep</p><script>never closed <p>gone</p>"), "Keep");
});
