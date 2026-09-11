import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, plainTheme, renderContext, renderLines, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";

const DDG_HTML = `<a class="result__a" href="https://a.test/one">One</a><a class="result__snippet" href="https://a.test/one">first</a><a class="result__a" href="https://a.test/two">Two</a>`;

const MANY = Array.from({ length: 10 }, (_, i) => `<a class="result__a" href="https://a.test/${i}">R${i}</a>`).join("");

/** Route the global fetch: DDG answers with `ddg`, everything else is down. */
function stubFetch(ddg: string, ddgStatus = 200): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("duckduckgo")) return new Response(ddg, { status: ddgStatus, headers: { "content-type": "text/html" } });
		return new Response("nope", { status: 503 });
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

async function asRole(role: string | undefined, fn: () => Promise<void>): Promise<void> {
	const saved = { role: process.env.PI_TOOLKIT_ROLE, depth: process.env.PI_TOOLKIT_DEPTH };
	if (role) {
		process.env.PI_TOOLKIT_ROLE = role;
		process.env.PI_TOOLKIT_DEPTH = "1";
	} else {
		delete process.env.PI_TOOLKIT_ROLE;
		delete process.env.PI_TOOLKIT_DEPTH;
	}
	try {
		await fn();
	} finally {
		if (saved.role === undefined) delete process.env.PI_TOOLKIT_ROLE;
		else process.env.PI_TOOLKIT_ROLE = saved.role;
		if (saved.depth === undefined) delete process.env.PI_TOOLKIT_DEPTH;
		else process.env.PI_TOOLKIT_DEPTH = saved.depth;
	}
}

test("module shape", () => {
	assert.equal(module.id, "web");
	assert.equal(module.order, 60);
	assert.deepEqual(module.child, ["web"]);
	assert.equal(module.default, true);
});

test("web child: registers web_search and web_fetch with self-rendered frames, no command", async () => {
	tempAgentDir();
	await asRole("web", async () => {
		const pi = new FakePi();
		const kit = createToolkit(pi as any, { modules: {} });
		assert.equal(kit.role.role, "web");
		await module.setup(pi as any, kit);
		assert.deepEqual([...pi.tools.keys()], ["web_search", "web_fetch"]);
		assert.equal(pi.commands.size, 0);
		assert.equal(pi.tools.get("web_search")?.renderShell, "self");
		assert.equal(pi.tools.get("web_fetch")?.renderShell, "self");
		assert.equal(pi.tools.get("web_fetch")?.promptGuidelines?.length, 1);
	});
});

test("main session: only /web unless toolsInMain is set", async () => {
	tempAgentDir();
	await asRole(undefined, async () => {
		const pi = new FakePi();
		await module.setup(pi as any, createToolkit(pi as any, { modules: {} }));
		assert.equal(pi.tools.size, 0);
		assert.deepEqual([...pi.commands.keys()], ["web"]);

		const pi2 = new FakePi();
		await module.setup(pi2 as any, createToolkit(pi2 as any, { modules: {}, web: { toolsInMain: true } }));
		assert.deepEqual([...pi2.tools.keys()], ["web_search", "web_fetch"]);
		assert.equal(pi2.commands.size, 1);
	});
});

test("/web key stores and lists keys; /web <query> prints a frame, never a message", async () => {
	tempAgentDir();
	await asRole(undefined, async () => {
		const pi = new FakePi();
		const kit = createToolkit(pi as any, { modules: {} });
		await module.setup(pi as any, kit);
		const web = pi.commands.get("web")!;
		const ctx = makeCtx();

		await web.handler("key brave abcd1234", ctx);
		assert.equal((kit.settings.web as any).keys.brave, "abcd1234");
		assert.match(ctx.ui.notifications.at(-1).message, /brave key saved \(…1234\)/);
		await web.handler("key", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /brave: set, tavily: unset, serper: unset/);
		await web.handler("key brave", ctx);
		assert.equal((kit.settings.web as any).keys.brave, undefined);
		await web.handler("key bing x", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /Unknown backend/);
		await web.handler("", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /^Usage:/);

		const restore = stubFetch(DDG_HTML);
		try {
			await web.handler("keyboard layouts", ctx);
		} finally {
			restore();
		}
		assert.equal(pi.sent.length, 0);
		const entry = pi.entries.at(-1)?.data as { title: string; head: string[]; lines: string[]; state: string };
		assert.equal(entry.title, "WEB SEARCH");
		assert.deepEqual(entry.head, ["keyboard layouts"]);
		assert.equal(entry.state, "ok");
		assert.deepEqual(entry.lines, ["1. One — https://a.test/one", "   first", "2. Two — https://a.test/two"]);
	});
});

test("web_search: executes against the backends, renders the frame, collapses to 6 lines, throws when every backend fails", async () => {
	tempAgentDir();
	await asRole("web", async () => {
		const pi = new FakePi();
		await module.setup(pi as any, createToolkit(pi as any, { modules: {} }));
		const tool = pi.tools.get("web_search")!;

		let restore = stubFetch(DDG_HTML);
		let result: any;
		try {
			result = await tool.execute("c1", { query: "hello" }, undefined, undefined, makeCtx());
		} finally {
			restore();
		}
		assert.equal(result.content[0].text, "1. One — https://a.test/one\n   first\n2. Two — https://a.test/two");
		assert.equal(result.details.backend, "ddg");
		assert.equal(result.details.total, 2);

		const rc = renderContext({ query: "hello" });
		const top = renderLines(tool.renderCall!({ query: "hello", recency: "week" }, plainTheme, rc), 60);
		assert.ok(top[0].startsWith("╭─ WEB SEARCH ─"), top[0]);
		assert.equal(top[1], "│ hello  (last week)");
		const bottom = renderLines(tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, rc), 60);
		assert.equal(bottom[0], "│ 1. One — https://a.test/one");
		assert.equal(bottom[3], "│ 2 results via ddg");
		assert.equal(bottom.length, 4, "no closing border");
		assert.equal(rc.state.done, true);
		assert.equal(rc.state.error, false);
		assert.ok(renderLines(tool.renderCall!({ query: "hello" }, plainTheme, rc), 60)[0].startsWith("╭─ WEB SEARCH ─"));

		restore = stubFetch(MANY);
		try {
			result = await tool.execute("c2", { query: "many", count: 10 }, undefined, undefined, makeCtx());
		} finally {
			restore();
		}
		const collapsed = renderLines(tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, renderContext({ query: "many" })), 80);
		assert.equal(collapsed.filter((l) => /^│ \d+\. R\d/.test(l)).length, 6);
		assert.ok(collapsed.some((l) => /\+4 lines/.test(l)), collapsed.join("\n"));
		const expanded = renderLines(tool.renderResult!(result, { expanded: true, isPartial: false }, plainTheme, renderContext({ query: "many" })), 80);
		assert.equal(expanded.filter((l) => /^│ \d+\. R\d/.test(l)).length, 10);

		await assert.rejects(tool.execute("c3", {}, undefined, undefined, makeCtx()), /pass query or queries/);
		restore = stubFetch("", 503);
		try {
			await assert.rejects(tool.execute("c4", { query: "down" }, undefined, undefined, makeCtx()), /web_search: .*ddg: DuckDuckGo HTTP 503/);
		} finally {
			restore();
		}
	});
});

test("web_fetch: executes, reports kind and size in the footer, throws on refusals", async () => {
	tempAgentDir();
	await asRole("web", async () => {
		const pi = new FakePi();
		await module.setup(pi as any, createToolkit(pi as any, { modules: {} }));
		const tool = pi.tools.get("web_fetch")!;
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/pdf")) return new Response("%PDF-", { status: 200, headers: { "content-type": "application/pdf" } });
			return new Response(`<title>Page</title><main><p>Hello <b>there</b></p></main>`, { status: 200, headers: { "content-type": "text/html" } });
		}) as typeof fetch;
		try {
			const result = await tool.execute("f1", { url: "https://a.test/x", selector: "main" }, undefined, undefined, makeCtx());
			assert.equal(result.content[0].text, "# Page\n\nHello **there**");
			assert.equal(result.details.kind, "html");
			assert.equal(result.details.selectorMatched, true);
			const rc = renderContext({ url: "https://a.test/x", selector: "main" });
			const top = renderLines(tool.renderCall!({ url: "https://a.test/x", selector: "main" }, plainTheme, rc), 60);
			assert.ok(top[0].startsWith("╭─ WEB FETCH ─"));
			assert.equal(top[1], "│ https://a.test/x  [main]");
			const bottom = renderLines(tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, rc), 60);
			assert.equal(bottom[0], "│ # Page");
			assert.equal(bottom.at(-1), "│ html · 23 chars");
			await assert.rejects(tool.execute("f2", { url: "https://a.test/pdf" }, undefined, undefined, makeCtx()), /PDF not supported/);
		} finally {
			globalThis.fetch = original;
		}
	});
});
