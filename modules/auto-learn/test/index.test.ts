import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createToolkit } from "../../../core/kit.ts";
import { FRAME_ENTRY } from "../../../core/print.ts";
import { FakePi, makeCtx, plainTheme, renderLines, tempAgentDir } from "../../../test/harness.ts";
import { resetRootCache } from "../detect.ts";
import module, { CUSTOM_TYPE, DETAILS_KEY, LESSONS_TYPE, STATUS_KEY, withNote } from "../index.ts";
import { resetRepoCache, resolveRepo } from "../repo.ts";
import { DAY_MS, saveLesson, type StoreOptions } from "../store.ts";

/** `entries` is the live session: tests push to it the way pi stores messages. */
async function boot(entries: any[] = []) {
	const agent = tempAgentDir();
	resetRepoCache();
	resetRootCache();
	const cwd = mkdtempSync(join(tmpdir(), "pi-toolkit-learn-cwd-"));
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	const store: StoreOptions = { dir: join(agent, "toolkit", "learn"), ttlMs: 7 * DAY_MS, maxPerRepo: 20, maxLessonChars: 800 };
	return { pi, kit, ctx: makeCtx({ cwd, entries }), cwd, agent, store, entries, repo: resolveRepo(cwd) };
}

const FAIL_TEXT = "cat: missing.txt: No such file or directory\n\nCommand exited with code 1";
const NOTE_L1 =
	'[auto-learn L1] Once you have a verified fix (a retry that happens to pass is not proof), save the cause and what to do next time — tool usage, command syntax, environment, test setup; not where code lives: learn({failureId:"L1", lesson:"…"}). Replace a related lesson rather than adding a near-duplicate. Skip transient failures, typos and expected results.';
const failing = (toolCallId = "c1") => ({ toolName: "bash", toolCallId, input: { command: "cat missing.txt" }, content: [{ type: "text", text: FAIL_TEXT }], details: {}, isError: true });
const reading = (toolCallId = "r1", path = "a.txt") => ({ toolName: "read", toolCallId, input: { path }, content: [{ type: "text", text: "hello" }], details: undefined, isError: false });
const userEntry = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const lessonsEntry = (message: any) => ({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
const textAt = (m: any) => m.content[0].text;
const startBlock = (label: string, ...lessons: string[]) => `Lessons from earlier failures in ${label} (auto-learn, expire after 7 days; verify before relying on one):\n${lessons.map((l) => `- ${l}`).join("\n")}`;
const newBlock = (label: string, ...lessons: string[]) => `[auto-learn] New lesson${lessons.length === 1 ? "" : "s"} for ${label} (verify before relying on one):\n${lessons.map((l) => `- ${l}`).join("\n")}`;
const rows = (pi: FakePi, kind: string) => pi.entries.filter((e) => e.customType === CUSTOM_TYPE && (e.data as any).kind === kind).map((e) => e.data as any);

test("a failure's note is written into the stored result; requests are never rewritten", async () => {
	const { pi, ctx } = await boot();
	const patched = await pi.chainToolResult(failing(), ctx);
	assert.equal(patched.content.length, 1, "appended to the existing text block");
	assert.equal(textAt(patched), `${FAIL_TEXT}\n\n${NOTE_L1}`);
	assert.equal(pi.handlers.has("context"), false, "no per-request rewrite, so the cached prefix never changes");
	assert.equal(pi.handlers.has("turn_end"), false, "no steered messages: lessons ride on tool results");
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), "1 nudged");
	assert.deepEqual(withNote([{ type: "image" }], "n"), [{ type: "image" }, { type: "text", text: "n" }]);
});

test("permission refusals get the stop-and-record note", async () => {
	const { pi, ctx } = await boot();
	const refused = "[permissions] blocked by permissions: rm -rf / (rule: no-rm-root)";
	const r = await pi.chainToolResult({ toolName: "bash", toolCallId: "p1", input: { command: "rm -rf /" }, content: [{ type: "text", text: refused }], details: {}, isError: true }, ctx);
	assert.match(textAt(r), /\n\n\[auto-learn L1\] Permission refusal: stop, do not retry it or route around it.*record exactly what was blocked and its scope, nothing broader/);
});

test("expected exits, successes and wrong path guesses are left alone", async () => {
	const { pi, ctx } = await boot();
	const grep = await pi.chainToolResult({ ...failing("g1"), input: { command: "grep foo src" }, content: [{ type: "text", text: "Command exited with code 1" }] }, ctx);
	const ok = await pi.chainToolResult({ ...failing("ok"), content: [{ type: "text", text: "all good" }], isError: false }, ctx);
	const missing = await pi.chainToolResult({ toolName: "read", toolCallId: "m", input: { path: "api/X.php" }, content: [{ type: "text", text: "ENOENT: no such file or directory, access 'api/X.php'" }], isError: true }, ctx);
	assert.equal(textAt(grep), "Command exited with code 1");
	assert.equal(textAt(ok), "all good");
	assert.equal(textAt(missing), "ENOENT: no such file or directory, access 'api/X.php'");
	assert.equal(ctx.ui.statuses.has(STATUS_KEY), false);
});

test("session start injects every known lesson once, as a stored message with a token estimate", async () => {
	const { pi, ctx, store, repo, entries } = await boot();
	const known = "Build with make -j4; plain make is too slow.";
	await saveLesson(store, repo.key, { text: known, repoLabel: repo.label });
	await pi.emit("session_start", { reason: "startup" }, ctx);

	let [res] = await pi.emit("before_agent_start", { prompt: "go" }, ctx);
	assert.equal(res.message.customType, LESSONS_TYPE);
	assert.equal(res.message.display, true);
	assert.equal(res.message.content, startBlock(repo.label, known));
	assert.equal(res.message.details.trigger, "start");
	assert.equal(res.message.details.repo, repo.label);
	assert.deepEqual(res.message.details.lessons.map((l: any) => l.text), [known]);
	assert.equal(res.message.details.tokens, Math.ceil(Buffer.byteLength(res.message.content) / 4));
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), "1 in context");

	entries.push(userEntry("go"), lessonsEntry(res.message));
	[res] = await pi.emit("before_agent_start", { prompt: "more" }, ctx);
	assert.equal(res, undefined, "already in context: nothing repeated");
	const read = await pi.chainToolResult(reading(), ctx);
	assert.equal(textAt(read), "hello", "nor on a tool result");
});

test("a lesson saved mid-run rides on the next tool result, once, with an INJECTED row", async () => {
	const { pi, ctx, store, repo, entries } = await boot();
	await pi.emit("session_start", { reason: "startup" }, ctx);
	let [res] = await pi.emit("before_agent_start", { prompt: "go" }, ctx);
	assert.equal(res, undefined, "no lessons yet");
	entries.push(userEntry("go"));

	const fromChild = "Tests run with pwsh tests/run.ps1, not phpunit.";
	const saved = await saveLesson(store, repo.key, { text: fromChild, repoLabel: repo.label, origin: { provider: null, model: null, thinkingLevel: null, role: "worker" } });
	const first = await pi.chainToolResult(reading("r1"), ctx);
	assert.equal(textAt(first), `hello\n\n${newBlock(repo.label, fromChild)}`);
	assert.deepEqual(first.details, { [DETAILS_KEY]: { lessons: [saved.lesson.id] } }, "delivered ids are kept for a resume");
	const [row] = rows(pi, "injected");
	assert.equal(row.trigger, "turn");
	assert.equal(row.lessons[0].role, "worker");
	assert.equal(row.tokens, Math.ceil(Buffer.byteLength(newBlock(repo.label, fromChild)) / 4));
	assert.equal(textAt(await pi.chainToolResult(reading("r2"), ctx)), "hello", "delivered once");

	const late = "Redis channels are per REDIS_DB; prefix them.";
	await saveLesson(store, repo.key, { text: late, repoLabel: repo.label });
	[res] = await pi.emit("before_agent_start", { prompt: "next" }, ctx);
	assert.equal(res.message.details.trigger, "prompt", "a new prompt takes what arrived while idle");
	assert.equal(res.message.content, startBlock(repo.label, late), "only the new lesson");
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), "2 in context");
});

test("learn stores the lesson, draws a LEARNED row, and the lesson joins the context on the next other tool result", async () => {
	const { pi, ctx, agent, repo } = await boot();
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.chainToolResult(failing(), ctx);

	const learn = pi.tools.get("learn");
	assert.ok(learn, "learn tool registered");
	assert.equal(learn.renderShell, "self");
	await assert.rejects(learn.execute("t0", { failureId: "L9", lesson: "unknown id lesson text here" }, undefined, undefined, ctx), /Unknown failureId "L9"/);
	await assert.rejects(learn.execute("t0", { failureId: "L1", lesson: "n/a" }, undefined, undefined, ctx), /placeholder/);

	const lesson = "cat needs the path from the repo root; run it from there.";
	const r = await learn.execute("t1", { failureId: "L1", lesson }, undefined, undefined, ctx);
	assert.match(textAt(r), /^Learned \(.+\); expires in 6d 23h\.$/);
	assert.equal(r.details.status, "added");
	const file = JSON.parse(readFileSync(join(agent, "toolkit", "learn", `${repo.key}.json`), "utf8"));
	assert.equal(file.lessons[0].text, lesson);
	assert.deepEqual(file.lessons[0].origin, { provider: "test", model: "test-model", thinkingLevel: "medium", role: "main" });
	assert.equal((await learn.execute("t2", { failureId: "L1", lesson: "Another lesson about something else here." }, undefined, undefined, ctx)).details.status, "handled");

	const learnResult = await pi.chainToolResult({ toolName: "learn", toolCallId: "t1", input: { failureId: "L1", lesson }, content: r.content, details: r.details, isError: false }, ctx);
	assert.equal(textAt(learnResult), textAt(r), "the learn result only confirms the save");
	const next = await pi.chainToolResult(reading(), ctx);
	assert.equal(textAt(next), `hello\n\n${newBlock(repo.label, lesson)}`);
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), "1 in context · 1 nudged · 1 saved");

	assert.deepEqual(rows(pi, "learned"), [{ kind: "learned", repo: repo.label, lesson }]);
	const render = pi.entryRenderers.get(CUSTOM_TYPE)!;
	const tokens = Math.ceil(Buffer.byteLength(`- ${lesson}\n`) / 4);
	const short = repo.label.split("/").pop();
	assert.deepEqual(renderLines(render({ data: rows(pi, "learned")[0] }, { expanded: false }, plainTheme), 160), [`◆ LEARNED · ${short} · ~${tokens} tok`, `  - ${lesson}`]);
	const injected = renderLines(render({ data: rows(pi, "injected")[0] }, { expanded: false }, plainTheme), 160);
	assert.match(injected[0], new RegExp(`^◆ INJECTED · mid-turn · ${short} · 1 lesson · ~\\d+ tok$`));
});

test("a near-duplicate is refused with the existing text and the failure stays open for a replace", async () => {
	const { pi, ctx, store, repo } = await boot();
	const existing = "When searching PHP attribute text containing parentheses with grep, set literal:true unless a regular expression is required.";
	await saveLesson(store, repo.key, { text: existing, repoLabel: repo.label });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.chainToolResult(failing(), ctx);
	const learn = pi.tools.get("learn")!;
	const near = "When searching PHP named-argument or bracket text with grep, use literal:true to avoid malformed regular expressions.";
	const r = await learn.execute("t1", { failureId: "L1", lesson: near }, undefined, undefined, ctx);
	assert.equal(r.details.status, "similar");
	assert.match(textAt(r), /^Not saved: .+ already has a similar lesson: "When searching PHP attribute text/);
	assert.equal(rows(pi, "learned").length, 0);
	const replaced = await learn.execute("t2", { failureId: "L1", lesson: near, action: "replace", replaces: [existing] }, undefined, undefined, ctx);
	assert.equal(replaced.details.status, "replaced");
	assert.equal(rows(pi, "updated").length, 1);
});

test("a tool call into another repo brings that repo's lessons on its own result", async (t) => {
	const { pi, ctx, store } = await boot();
	const other = mkdtempSync(join(tmpdir(), "pi-toolkit-learn-other-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: other, stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", "https://example.com/acme/other.git"], { cwd: other, stdio: "ignore" });
	} catch {
		t.skip("git is not available");
		return;
	}
	const otherRepo = resolveRepo(other);
	assert.equal(otherRepo.label, "example.com/acme/other");
	const a = "Run the other repo's tests with npm run test:unit.";
	const b = "The other repo's lint needs node 22.";
	await saveLesson(store, otherRepo.key, { text: a, repoLabel: otherRepo.label });
	await saveLesson(store, otherRepo.key, { text: b, repoLabel: otherRepo.label });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	assert.equal((await pi.emit("before_agent_start", { prompt: "go" }, ctx))[0], undefined, "the session's own repo has none");

	const read = await pi.chainToolResult(reading("r1", join(other, "src", "x.ts")), ctx);
	assert.equal(textAt(read), `hello\n\n[auto-learn] Lessons for example.com/acme/other, a repo this session just touched (expire after 7 days; verify before relying on one):\n- ${a}\n- ${b}`);
	assert.equal(rows(pi, "injected")[0].trigger, "repo");
	const again = await pi.chainToolResult({ toolName: "bash", toolCallId: "b1", input: { command: `cd ${other.replace(/\\/g, "/")} && ls` }, content: [{ type: "text", text: "src" }], isError: false }, ctx);
	assert.equal(textAt(again), "src", "once per repo");

	await pi.chainToolResult({ toolName: "bash", toolCallId: "f1", input: { command: `cd ${other.replace(/\\/g, "/")} && npm run lint` }, content: [{ type: "text", text: "Command exited with code 2" }], isError: true }, ctx);
	const r = await pi.tools.get("learn")!.execute("t1", { failureId: "L1", lesson: "npm ci must come before any npm script in a fresh clone." }, undefined, undefined, ctx);
	assert.equal(r.details.repo, "example.com/acme/other", "a failure belongs to the repo the call ran in");
});

test("a resumed session counts the lessons and notes already in its context", async () => {
	const { pi, ctx, store, repo, entries } = await boot();
	const injected = await saveLesson(store, repo.key, { text: "Build with make -j4; plain make is too slow.", repoLabel: repo.label });
	const delivered = await saveLesson(store, repo.key, { text: "Docs build needs mkdocs from pipx.", repoLabel: repo.label });
	entries.push(
		userEntry("go"),
		{ type: "custom_message", customType: LESSONS_TYPE, details: { trigger: "start", repo: repo.label, lessons: [{ id: injected.lesson.id, text: injected.lesson.text, role: null }] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", toolCallId: "old", content: [{ type: "text", text: `${FAIL_TEXT}\n\n${NOTE_L1.replaceAll("L1", "L4")}` }] } },
		{ type: "message", message: { role: "toolResult", toolName: "read", toolCallId: "r", content: [{ type: "text", text: "x" }], details: { [DETAILS_KEY]: { lessons: [delivered.lesson.id] } } } },
	);
	await pi.emit("session_start", { reason: "resume" }, ctx);
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), "2 in context · 4 nudged");
	const [res] = await pi.emit("before_agent_start", { prompt: "again" }, ctx);
	assert.equal(res, undefined);
	const patched = await pi.chainToolResult(failing("new"), ctx);
	assert.match(textAt(patched), /\[auto-learn L5\]/, "ids continue after the resumed notes");
});

test("a compaction that drops lessons re-injects them and says so", async () => {
	const { pi, ctx, store, repo, entries } = await boot();
	const known = "Build with make -j4; plain make is too slow.";
	await saveLesson(store, repo.key, { text: known, repoLabel: repo.label });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	const [first] = await pi.emit("before_agent_start", { prompt: "go" }, ctx);
	entries.push(userEntry("go"), lessonsEntry(first.message));

	await pi.emit("session_compact", { reason: "threshold" }, ctx);
	let [res] = await pi.emit("before_agent_start", { prompt: "kept" }, ctx);
	assert.equal(res, undefined, "the lesson message survived the compaction");

	entries.splice(0, entries.length, { type: "compaction" }, userEntry("recent"));
	await pi.emit("session_compact", { reason: "threshold" }, ctx);
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), undefined, "nothing in context any more");
	[res] = await pi.emit("before_agent_start", { prompt: "after" }, ctx);
	assert.equal(res.message.details.trigger, "compaction");
	assert.equal(res.message.content, startBlock(repo.label, known));
});

test("the INJECTED row names the trigger, repo, count, token estimate and who learned it", async () => {
	const { pi } = await boot();
	const render = pi.messageRenderers.get(LESSONS_TYPE)!;
	const lessons = [
		{ id: "a", text: "One.", role: "worker" },
		{ id: "b", text: "Two.", role: "main" },
	];
	const draw = (trigger: string, list = lessons, expanded = false) =>
		renderLines(render({ customType: LESSONS_TYPE, content: "", display: true, details: { trigger, repo: "github.com/acme/widgets", lessons: list, tokens: 42 } }, { expanded }, plainTheme), 120);
	assert.deepEqual(draw("turn"), ["◆ INJECTED · mid-turn · widgets · 2 lessons · ~42 tok · learned by worker", "  - One.", "  - Two."]);
	assert.equal(draw("start", lessons.slice(1))[0], "◆ INJECTED · session start · widgets · 1 lesson · ~42 tok");
	assert.equal(draw("repo", lessons.slice(1))[0], "◆ INJECTED · repo seen · widgets · 1 lesson · ~42 tok");
	assert.equal(draw("compaction", lessons.slice(1))[0], "◆ INJECTED · after compaction · widgets · 1 lesson · ~42 tok");
	const many = Array.from({ length: 9 }, (_, i) => ({ id: String(i), text: `Lesson ${i}.`, role: null }));
	assert.equal(draw("start", many).length, 1 + 6 + 1, "collapsed: six lessons and a hint");
	assert.equal(draw("start", many, true).length, 10);
	const narrow = renderLines(render({ details: { trigger: "start", repo: "r", lessons: [{ id: "x", text: "word ".repeat(30), role: null }], tokens: 9 } }, { expanded: false }, plainTheme), 40);
	assert.ok(narrow.length > 2 && narrow.every((l) => visibleWidth(l) <= 40), "long lessons wrap");
});

test("/learn lists in a frame, forget removes, off disables", async () => {
	const { pi, ctx, store, repo } = await boot();
	await saveLesson(store, repo.key, { text: "First lesson about the toolchain.", repoLabel: repo.label });
	await saveLesson(store, repo.key, { text: "Second note on the test runner.", repoLabel: repo.label });
	const command = pi.commands.get("learn");
	assert.ok(command);

	await command.handler("", ctx);
	const frame = pi.entries.find((e) => e.customType === FRAME_ENTRY)?.data as any;
	assert.ok(frame, "list is printed through kit.print");
	assert.equal(frame.title, "learn");
	assert.equal(frame.head[0], repo.label);
	assert.match(frame.head[1], /^2 lessons · on · 7-day expiry/);
	assert.match(frame.lines[0], /^1\. First lesson about the toolchain\.  \(expires in 6d 23h\)$/);
	assert.match(frame.lines[1], /^2\. Second note/);

	await command.handler("forget 1", ctx);
	assert.match(ctx.ui.notifications.at(-1).message, /^forgot: First lesson/);
	await command.handler("forget 7", ctx);
	assert.equal(ctx.ui.notifications.at(-1).message, "no lesson #7");
	await command.handler("", ctx);
	const after = pi.entries.filter((e) => e.customType === FRAME_ENTRY).at(-1)?.data as any;
	assert.equal(after.lines.length, 1);
	assert.match(after.lines[0], /^1\. Second note/);

	await command.handler("off", ctx);
	assert.equal(ctx.ui.statuses.get(STATUS_KEY), "off");
	assert.equal(textAt(await pi.chainToolResult(failing(), ctx)), FAIL_TEXT, "disabled: no note");
	const [off] = await pi.emit("before_agent_start", { prompt: "x" }, ctx);
	assert.equal(off, undefined, "disabled: no lessons");
	await command.handler("on", ctx);
	const [on] = await pi.emit("before_agent_start", { prompt: "y" }, ctx);
	assert.equal(on.message.content, startBlock(repo.label, "Second note on the test runner."), "the remaining lesson rides along");
	assert.equal(textAt(await pi.chainToolResult(failing("c2"), ctx)), `${FAIL_TEXT}

${NOTE_L1}`, "re-enabled");
});

test("the LEARN tool row: a frame while running, gone once saved, one line otherwise, the frame when expanded", async () => {
	const { pi, ctx, repo } = await boot();
	await pi.chainToolResult(failing(), ctx);
	const learn = pi.tools.get("learn")!;
	const width = 200;
	const draw = (details: any, expanded = false, isError = false) => {
		const state: Record<string, unknown> = {};
		const context = { args: { failureId: "L1" }, state, lastComponent: undefined, invalidate: () => {}, isError, expanded };
		const top = learn.renderCall!({ failureId: "L1" }, plainTheme, context);
		const running = renderLines(top, width);
		const result = { content: [{ type: "text", text: isError ? "Unknown failureId \"L9\"." : "ok" }], details };
		const bottom = learn.renderResult!(result, { expanded }, plainTheme, context);
		return { running, top: renderLines(top, width), bottom: renderLines(bottom, width) };
	};
	const saved = draw({ status: "added", repo: repo.label, lesson: "A lesson." });
	assert.match(saved.running[0], /^╭─ LEARN ─+$/);
	assert.equal(saved.running[1], `│ ${repo.label}`);
	assert.deepEqual([saved.top, saved.bottom], [[], []], "the ◆ LEARNED row stands for it");

	const similar = draw({ status: "similar", repo: repo.label, lesson: "Old." });
	assert.deepEqual(similar.top, [`✓ LEARN ${repo.label.split("/").pop()} · not saved: a similar lesson exists`]);
	assert.deepEqual(similar.bottom, []);
	assert.match(draw(undefined, false, true).top[0], /^✗ LEARN .* · Unknown failureId "L9"\.$/);

	const open = draw({ status: "added", repo: repo.label, lesson: "A lesson." }, true);
	assert.match(open.top[0], /^╭─ LEARN/);
	assert.equal(open.bottom[0], "│ learned: A lesson.");
});

test("PI_TOOLKIT_LEARN=off registers nothing", async () => {
	process.env.PI_TOOLKIT_LEARN = "off";
	try {
		const { pi } = await boot();
		assert.equal(pi.tools.has("learn"), false);
		assert.equal(pi.commands.has("learn"), false);
		assert.equal(pi.handlers.size, 0);
	} finally {
		delete process.env.PI_TOOLKIT_LEARN;
	}
});
