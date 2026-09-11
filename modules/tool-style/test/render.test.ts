import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BUILTIN_TOOL_NAMES, createToolkit } from "../../../core/kit.ts";
import { FakePi, plainTheme, renderContext, tempAgentDir } from "../../../test/harness.ts";
import module, { toolRenderers } from "../index.ts";
import { countLines, displayPath, headLines, stripModelNotes, stripReadFooter, summaryStats } from "../render.ts";

/** Wraps every colour call in tags so the colouring path can be asserted on. */
const tagTheme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
};

const cwd = resolve("/proj");
const inProj = (...parts: string[]) => join(cwd, ...parts);

function text(t: string, details: unknown = {}) {
	return { content: [{ type: "text", text: t }], details };
}

function numbered(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

async function patchedTools() {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	kit.flushToolPatches(pi as any);
	return pi.tools;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("every built-in tool is re-registered with its own frame", async () => {
	const tools = await patchedTools();
	for (const name of BUILTIN_TOOL_NAMES) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} registered`);
		assert.equal(tool.renderShell, "self");
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
		assert.equal(typeof tool.execute, "function");
	}
});

test("bash collapsed shows the tail of the output with an expand hint while it runs", () => {
	const { renderCall, renderResult } = toolRenderers("bash");
	const state = {};
	const ctx = renderContext({ command: "git status" }, { state, cwd });
	const top = renderCall(ctx.args, plainTheme, ctx).render(80);
	assert.equal(top[0], `╭─ BASH ${"─".repeat(18)}`);
	assert.equal(top[1], "│ git status");
	assert.equal(top[2], "│ ");

	const bottom = renderResult(text(numbered(10)), { expanded: false, isPartial: true }, plainTheme, ctx).render(80);
	assert.equal(bottom[0], "│ … 4 earlier lines hidden");
	assert.deepEqual(bottom.slice(1, 7), ["│ line 5", "│ line 6", "│ line 7", "│ line 8", "│ line 9", "│ line 10"]);
	assert.match(bottom[7], /to expand/);
	assert.equal(bottom.length, 8);
});

test("expanded shows every line and no hint", () => {
	const { renderResult } = toolRenderers("bash");
	const ctx = renderContext({ command: "ls" }, { cwd, expanded: true });
	const bottom = renderResult(text(numbered(10)), { expanded: true, isPartial: false }, plainTheme, ctx).render(80);
	assert.equal(bottom.length, 10);
	assert.equal(bottom[0], "│ line 1");
	assert.equal(bottom[9], "│ line 10");
	assert.ok(!bottom.some((l) => /to expand|hidden/.test(l)));
});

test("read shows the head, strips pi's footer, and ranges the path", () => {
	const { renderCall, renderResult } = toolRenderers("read");
	const ctx = renderContext({ path: inProj("src", "a.ts"), offset: 10, limit: 20 }, { cwd });
	const top = renderCall(ctx.args, plainTheme, ctx).render(80);
	assert.equal(top[1], "│ src/a.ts:10-29");

	const body = `${numbered(8)}\n\n[Showing lines 10-17 of 100. Use offset=18 to continue]`;
	const bottom = renderResult(text(body), { expanded: true, isPartial: false }, plainTheme, ctx).render(80);
	assert.deepEqual(bottom.slice(0, 6), ["│ line 1", "│ line 2", "│ line 3", "│ line 4", "│ line 5", "│ line 6"]);
	assert.equal(bottom.length, 8);
	assert.ok(!bottom.some((l) => l.includes("Showing lines")));
});

test("stripReadFooter only cuts a trailing bracketed footer", () => {
	assert.equal(stripReadFooter("a\nb\n\n[3 more lines in file]"), "a\nb");
	assert.equal(stripReadFooter("a\nb"), "a\nb");
	assert.equal(stripReadFooter("x = arr[1]"), "x = arr[1]");
});

test("the header runs, then closes once the result lands, invalidating once", async () => {
	const { renderCall, renderResult } = toolRenderers("bash");
	const state: Record<string, unknown> = {};
	let invalidations = 0;
	const before = renderContext({ command: "make" }, { state, cwd, executionStarted: false, invalidate: () => invalidations++ });
	const top = renderCall(before.args, tagTheme, before);
	assert.match(top.render(80)[0], /<warning>BASH<\/warning>/);
	assert.equal(top.render(80).length, 2, "no separator before a body exists");

	const after = renderContext({ command: "make" }, { state, cwd, invalidate: () => invalidations++, lastComponent: undefined });
	renderResult(text("ok"), { expanded: false, isPartial: false }, tagTheme, after);
	await tick();
	assert.equal(invalidations, 1);
	assert.equal(state.done, true);
	assert.equal(state.error, false);
	assert.equal(top.state, "ok", "the retained header flips before the next paint");
	assert.equal(top.separator, true);

	const again = renderContext({ command: "make" }, { state, cwd, lastComponent: top, invalidate: () => invalidations++ });
	const reused = renderCall(again.args, tagTheme, again);
	assert.equal(reused, top, "lastComponent is updated in place");
	assert.deepEqual(reused.render(80), ["<success>✓ BASH</success> <accent>make</accent> <muted>· ok</muted>"], "finished and collapsed: one summary line");

	renderResult(text("ok"), { expanded: false, isPartial: false }, tagTheme, after);
	await tick();
	assert.equal(invalidations, 1, "never invalidates twice");
});

test("error results colour the header and every body line", () => {
	const { renderCall, renderResult } = toolRenderers("read");
	const state = {};
	const ctx = renderContext({ path: "missing.txt" }, { state, cwd, isError: true });
	assert.match(renderCall(ctx.args, tagTheme, ctx).render(80)[0], /<error>READ<\/error>/);
	const bottom = renderResult(text("ENOENT: no such file\nsecond"), { expanded: true, isPartial: false }, tagTheme, ctx).render(80);
	assert.equal(bottom[0], "<dim>│ </dim><error>ENOENT: no such file</error>");
	assert.equal(bottom[1], "<dim>│ </dim><error>second</error>");
	assert.equal((state as any).error, true);
	// With the plain theme the same path yields comparable text.
	const plain = renderResult(text("boom"), { expanded: true, isPartial: false }, plainTheme, renderContext({}, { cwd, isError: true })).render(80);
	assert.equal(plain[0], "│ boom");
});

test("an empty result says so", () => {
	const { renderResult } = toolRenderers("bash");
	const ctx = renderContext({ command: "true" }, { cwd });
	const bottom = renderResult(text(""), { expanded: true, isPartial: false }, plainTheme, ctx).render(80);
	assert.equal(bottom[0], "│ (no output)");
	assert.equal(bottom.length, 1);
	const tagged = renderResult(text("\n\n"), { expanded: true, isPartial: false }, tagTheme, renderContext({}, { cwd })).render(80);
	assert.equal(tagged[0], "<dim>│ </dim><muted>(no output)</muted>");
});

test("narrow width never exceeds the width", () => {
	const width = 20;
	const longCommand = `echo ${"x".repeat(100)}`;
	const output = [`${"y".repeat(90)}`, "short", `${"z".repeat(50)}\t${"w".repeat(50)}`].join("\n");
	for (const name of BUILTIN_TOOL_NAMES) {
		const { renderCall, renderResult } = toolRenderers(name);
		const ctx = renderContext({ command: longCommand, path: inProj("a".repeat(60)), pattern: "p".repeat(40), content: "c" }, { cwd });
		const lines = [
			...renderCall(ctx.args, plainTheme, ctx).render(width),
			...renderResult(text(output, { truncation: { truncated: true, outputLines: 3, totalLines: 999 } }), { expanded: true, isPartial: false }, plainTheme, ctx).render(width),
		];
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${name}: ${JSON.stringify(line)} is ${visibleWidth(line)} wide`);
	}
});

test("head lines per tool", () => {
	assert.deepEqual(headLines("bash", { command: "cd x &&\r\n  make" }, cwd), ["cd x &&", "  make"]);
	assert.deepEqual(headLines("bash", {}, cwd), ["…"]);
	assert.deepEqual(headLines("read", { path: inProj("src", "a.ts") }, cwd), ["src/a.ts"]);
	assert.deepEqual(headLines("read", { path: "src/a.ts", offset: 5 }, cwd), ["src/a.ts:5"]);
	assert.deepEqual(headLines("read", { path: "src/a.ts", limit: 3 }, cwd), ["src/a.ts:1-3"]);
	assert.deepEqual(headLines("edit", { path: inProj("src", "a.ts"), edits: [{}, {}] }, cwd), ["src/a.ts · 2 edits"]);
	assert.deepEqual(headLines("edit", { path: "a.ts", edits: [{}] }, cwd), ["a.ts · 1 edit"]);
	assert.deepEqual(headLines("write", { path: "n.md", content: "a\nb\nc\n" }, cwd), ["n.md · 3 lines"]);
	assert.deepEqual(headLines("grep", { pattern: "foo.*", path: inProj("src"), glob: "*.ts" }, cwd), ["foo.* · src · *.ts"]);
	assert.deepEqual(headLines("grep", { pattern: "foo" }, cwd), ["foo"]);
	assert.deepEqual(headLines("find", { pattern: "**/*.ts", path: inProj("src") }, cwd), ["**/*.ts · src"]);
	assert.deepEqual(headLines("ls", {}, cwd), ["."]);
	assert.deepEqual(headLines("ls", { path: cwd }, cwd), ["."]);
	assert.deepEqual(headLines("ls", { path: inProj("docs") }, cwd), ["docs"]);
});

test("paths outside cwd stay as given, under home become ~", () => {
	const elsewhere = resolve("/elsewhere/file.txt");
	assert.equal(displayPath(elsewhere, cwd), elsewhere);
	assert.equal(displayPath(join(homedir(), "notes.md"), cwd), "~/notes.md");
	assert.equal(displayPath(homedir(), cwd), "~");
	assert.equal(displayPath("", cwd), "");
	assert.equal(displayPath(42, cwd), "");
});

test("countLines ignores one trailing newline", () => {
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
	assert.equal(countLines("a\r\nb\r\n"), 2);
	assert.equal(countLines("a\n\n"), 2);
});

test("edit shows pi's diff with additions and removals coloured", () => {
	const { renderResult } = toolRenderers("edit");
	const ctx = renderContext({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }, { cwd });
	const diff = "  1 const a = 1;\n-2 const x = 1;\n+2 const y = 1;\n    ...";
	const bottom = renderResult(text("ok", { diff, patch: "", firstChangedLine: 2 }), { expanded: true, isPartial: false }, tagTheme, ctx).render(80);
	assert.equal(bottom[0], "<dim>│ </dim><muted>  1 const a = 1;</muted>");
	assert.equal(bottom[1], "<dim>│ </dim><error>-2 const x = 1;</error>");
	assert.equal(bottom[2], "<dim>│ </dim><success>+2 const y = 1;</success>");
	assert.equal(bottom[3], "<dim>│ </dim><muted>    ...</muted>");
});

test("write reports the line count", () => {
	const { renderResult } = toolRenderers("write");
	const ctx = renderContext({ path: "n.md", content: "a\nb\nc\n" }, { cwd });
	const bottom = renderResult(text("Successfully wrote 6 bytes"), { expanded: true, isPartial: false }, plainTheme, ctx).render(80);
	assert.equal(bottom[0], "│ Wrote 3 lines");
});

test("partial results scroll the tail and keep the header running", async () => {
	const { renderCall, renderResult } = toolRenderers("bash");
	const state: Record<string, unknown> = {};
	let invalidations = 0;
	const ctx = renderContext({ command: "npm test" }, { state, cwd, isPartial: true, invalidate: () => invalidations++ });
	const top = renderCall(ctx.args, plainTheme, ctx);
	const bottom = renderResult(text(numbered(9)), { expanded: false, isPartial: true }, plainTheme, ctx).render(80);
	await tick();
	assert.equal(state.done, undefined);
	assert.equal(invalidations, 0);
	assert.equal(top.state, "running");
	assert.equal(bottom[0], "│ … 3 earlier lines hidden");
	assert.equal(bottom[6], "│ line 9");
});

test("truncation notes land in the footer", () => {
	const { renderResult } = toolRenderers("bash");
	const ctx = renderContext({ command: "cat big" }, { cwd });
	const details = { truncation: { truncated: true, outputLines: 5, totalLines: 50 }, fullOutputPath: "/tmp/full.txt" };
	const bottom = renderResult(text("a\nb", details), { expanded: true, isPartial: false }, plainTheme, ctx).render(80);
	assert.deepEqual(bottom.slice(0, 4), ["│ a", "│ b", "│ truncated: 5 of 50 lines", "│ full output: /tmp/full.txt"]);

	const grep = toolRenderers("grep").renderResult(text("x:1: hit", { matchLimitReached: 100 }), { expanded: true, isPartial: false }, plainTheme, renderContext({}, { cwd })).render(80);
	assert.equal(grep[1], "│ stopped at 100 matches");
});

test("image reads show only the summary line", () => {
	const { renderResult } = toolRenderers("read");
	const ctx = renderContext({ path: "pic.png" }, { cwd });
	const result = { content: [{ type: "text", text: "Read image file pic.png (800x600)" }, { type: "image", data: "…", mimeType: "image/png" }], details: {} };
	const bottom = renderResult(result, { expanded: true, isPartial: false }, plainTheme, ctx).render(80);
	assert.equal(bottom[0], "│ Read image file pic.png (800x600)");
	assert.equal(bottom.length, 1);
});

test("a finished collapsed row is one summary line; expanding brings the frame back", async () => {
	const { renderCall, renderResult } = toolRenderers("read");
	const state: Record<string, unknown> = {};
	const args = { path: inProj("src", "a.ts"), offset: 1, limit: 40 };
	const running = renderContext(args, { state, cwd });
	const top = renderCall(args, plainTheme, running);
	const bottom = renderResult(text(numbered(40)), { expanded: false, isPartial: false }, plainTheme, running);
	await tick();
	assert.deepEqual(top.render(80), ["✓ READ src/a.ts:1-40 · 40 lines"]);
	assert.deepEqual(bottom.render(80), []);

	const open = renderContext(args, { state, cwd, expanded: true, lastComponent: top });
	assert.match(renderCall(args, plainTheme, open).render(80)[0], /^╭─ READ/);
	assert.equal(renderResult(text(numbered(40)), { expanded: true, isPartial: false }, plainTheme, { ...open, lastComponent: bottom }).render(80).length, 40);

	const closed = renderContext(args, { state, cwd, lastComponent: top });
	assert.equal(renderCall(args, plainTheme, closed).render(80).length, 1, "collapsing again shrinks it back");
});

test("summary lines: counts per tool, the bash verdict, and the error reason", () => {
	const stats = (tool: any, t: string, details: unknown = {}, isError = false) => summaryStats(tool, { result: text(t, details), args: {}, isError });
	assert.deepEqual(stats("bash", "compiling\nOK (12 tests)"), ["2 lines", "OK (12 tests)"]);
	assert.deepEqual(stats("bash", ""), ["no output"]);
	assert.deepEqual(stats("bash", "warn\nbash: pwsh: command not found\n\nCommand exited with code 127", {}, true), ["exit 127", "bash: pwsh: command not found"]);
	assert.deepEqual(stats("grep", "rg: regex parse error:\n    (?:foo(\n    ^\nerror: unclosed group", {}, true), ["rg: regex parse error:"]);
	assert.deepEqual(stats("read", "ENOENT: no such file", {}, true), ["ENOENT: no such file"]);
	assert.deepEqual(stats("grep", "a.ts:1: x\na.ts-2- ctx\nb.ts:9: y", { matchLimitReached: 100 }), ["2 matches", "stopped at 100 matches"]);
	assert.deepEqual(stats("grep", "No matches found"), ["No matches found"]);
	assert.deepEqual(stats("edit", "ok", { diff: " 1 a\n-2 b\n+2 c\n+3 d" }), ["+2 −1"]);
	assert.deepEqual(stats("find", "a.ts\nb.ts"), ["2 results"]);
	assert.deepEqual(stats("ls", "a\nb\nc"), ["3 entries"]);
	assert.deepEqual(stats("ls", "(empty directory)"), ["empty"]);
	assert.deepEqual(stats("write", "Successfully wrote 6 bytes"), []);
});

test("auto-learn notes and lesson blocks are not tool output", () => {
	assert.equal(stripModelNotes("out\n\n[auto-learn L1] Once you have a verified fix"), "out");
	assert.equal(stripModelNotes("out\n\n[auto-learn] New lesson for acme:\n- x"), "out");
	assert.equal(stripModelNotes("[auto-learn] only"), "");
	assert.equal(stripModelNotes("see [auto-learn L1] inline"), "see [auto-learn L1] inline");
	assert.deepEqual(summaryStats("bash", { result: text("one\ntwo\n\n[auto-learn] New lesson for acme:\n- x"), args: {}, isError: false }), ["2 lines", "two"]);
});
