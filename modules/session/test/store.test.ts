import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FrameBottom, FrameTop } from "../../../core/frame.ts";
import { FakePi, makeCtx, plainTheme, renderContext, renderLines, tempAgentDir } from "../../../test/harness.ts";
import { cacheDirFor, extractMessages, listSessionFiles, read, search } from "../index-store.ts";
import module from "../index.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Fixtures: pi-shaped JSONL sessions (see docs/session-format.md)

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function userEntry(id: string, text: string, ts: number) {
	return { type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: ts } };
}

function assistantEntry(id: string, blocks: unknown[], ts: number) {
	return {
		type: "message",
		id,
		timestamp: new Date(ts).toISOString(),
		message: { role: "assistant", content: blocks, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage: USAGE, stopReason: "stop", timestamp: ts },
	};
}

function toolResultEntry(id: string, text: string, ts: number) {
	return {
		type: "message",
		id,
		timestamp: new Date(ts).toISOString(),
		message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: ts },
	};
}

interface SessionSpec {
	uuid: string;
	cwd: string;
	startedAt: number;
	entries: Array<Record<string, unknown>>;
	/** Raw text appended after the last line (a torn write). */
	trailing?: string;
	/** File mtime to stamp. */
	mtime?: number;
}

/** Write `<agentDir>/sessions/--<cwd>--/<stamp>_<uuid>.jsonl` with a chained id/parentId tree. */
function writeSession(agentDir: string, spec: SessionSpec): string {
	const dirName = `--${spec.cwd.replace(/[\\/:]+/g, "-")}--`;
	const dir = join(agentDir, "sessions", dirName);
	mkdirSync(dir, { recursive: true });
	const stamp = new Date(spec.startedAt).toISOString().replace(/[:.]/g, "-");
	const file = join(dir, `${stamp}_${spec.uuid}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id: spec.uuid, timestamp: new Date(spec.startedAt).toISOString(), cwd: spec.cwd })];
	let parentId: string | null = null;
	for (const entry of spec.entries) {
		const id = String(entry.id);
		lines.push(JSON.stringify({ ...entry, id, parentId }));
		parentId = id;
	}
	let text = `${lines.join("\n")}\n`;
	if (spec.trailing) text += spec.trailing;
	writeFileSync(file, text, "utf8");
	if (spec.mtime) utimesSync(file, new Date(spec.mtime), new Date(spec.mtime));
	return file;
}

const ID_A = "01a0a001-0000-7000-8000-00000000000a";
const ID_B = "01a0b002-0000-7000-8000-00000000000b";
const ID_C = "01a0c003-0000-7000-8000-00000000000c";
const ID_D = "01a0d004-0000-7000-8000-00000000000d";
const CWD_A = process.platform === "win32" ? "C:\\proj\\alpha" : "/proj/alpha";
const CWD_B = process.platform === "win32" ? "C:\\proj\\beta" : "/proj/beta";

interface Fixture {
	agentDir: string;
	cacheDir: string;
	fileA: string;
	fileB: string;
	fileC: string;
	fileD: string;
	now: number;
}

function makeFixture(): Fixture {
	const agentDir = tempAgentDir("pi-toolkit-session-");
	const now = Date.now();
	const tA = now - 1 * HOUR; // newest session, cwd alpha
	const fileA = writeSession(agentDir, {
		uuid: ID_A,
		cwd: CWD_A,
		startedAt: tA,
		mtime: tA + 8000,
		entries: [
			{ type: "model_change", id: "aa000001", timestamp: new Date(tA).toISOString(), provider: "anthropic", modelId: "claude-sonnet-4-5" },
			{ type: "session_info", id: "aa000002", timestamp: new Date(tA).toISOString(), name: "dialer-plan" },
			userEntry("aa000010", "We decided to use swoole coroutines for the dialer worker pool.", tA + 1000),
			assistantEntry(
				"aa000011",
				[
					{ type: "thinking", thinking: "Hidden reasoning about swoole coroutines that must never be indexed: THINKSECRET" },
					{ type: "text", text: "Agreed: swoole coroutines it is. I will also keep redis as the queue." },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo ARGSECRET" } },
				],
				tA + 2000,
			),
			toolResultEntry("aa000012", "tool output about swoole internals: TOOLSECRET", tA + 3000),
			userEntry("aa000013", "ok", tA + 4000),
			userEntry("aa000014", "What about redis then?", tA + 5000),
			assistantEntry("aa000015", [{ type: "text", text: "Redis stays as the queue backend; nothing else changes." }], tA + 6000),
			{ type: "custom", id: "aa000016", timestamp: new Date(tA + 7000).toISOString(), customType: "toolkit", data: { swoole: "custom entries are not indexed" } },
		],
		trailing: '{"type":"message","id":"aa0000ff","parentId":"aa000016","message":{"role":"user","content":[{"type":"text","text":"torn swoole li',
	});
	const tB = now - 2 * DAY; // older, cwd beta
	const fileB = writeSession(agentDir, {
		uuid: ID_B,
		cwd: CWD_B,
		startedAt: tB,
		mtime: tB + 3000,
		entries: [
			userEntry("bb000010", "The swoole worker crashes on reload, any idea?", tB + 1000),
			assistantEntry("bb000011", [{ type: "text", text: "The crash comes from the reload path; restart the swoole server after the deploy." }], tB + 2000),
		],
	});
	const tC = now - 20 * DAY; // outside the 14-day window
	const fileC = writeSession(agentDir, {
		uuid: ID_C,
		cwd: CWD_A,
		startedAt: tC,
		mtime: tC,
		entries: [userEntry("cc000010", "Legacy swoole coroutines discussion from three weeks ago.", tC + 1000)],
	});
	const tD = now - 10 * 60_000; // the "current" session
	const fileD = writeSession(agentDir, {
		uuid: ID_D,
		cwd: CWD_A,
		startedAt: tD,
		mtime: tD + 2000,
		entries: [userEntry("dd000010", "Current session asking about swoole coroutines again.", tD + 1000)],
	});
	return { agentDir, cacheDir: join(agentDir, "toolkit", "session-index"), fileA, fileB, fileC, fileD, now };
}

/** createToolkit reads settings and the extension root; jiti gives pi `__dirname`, bare node does not. */
function kitFor(pi: FakePi, role: string | undefined, settings: Record<string, unknown> = {}) {
	(globalThis as any).__dirname ??= join(ROOT, "core");
	if (role) {
		process.env.PI_TOOLKIT_ROLE = role;
		process.env.PI_TOOLKIT_DEPTH = "1";
	}
	try {
		return createToolkit(pi as any, { modules: {}, ...settings });
	} finally {
		delete process.env.PI_TOOLKIT_ROLE;
		delete process.env.PI_TOOLKIT_DEPTH;
	}
}

// ---------------------------------------------------------------------------
// Store

test("listSessionFiles: 14-day window, recursive, newest first, exclude", () => {
	const f = makeFixture();
	const recent = listSessionFiles(f.agentDir, { days: 14 });
	assert.deepEqual(
		recent.map((x) => x.file),
		[f.fileD, f.fileA, f.fileB],
	);
	const wide = listSessionFiles(f.agentDir, { days: 60 });
	assert.equal(wide.length, 4);
	assert.ok(wide.some((x) => x.file === f.fileC));
	const excluded = listSessionFiles(f.agentDir, { days: 14, exclude: f.fileD });
	assert.deepEqual(
		excluded.map((x) => x.file),
		[f.fileA, f.fileB],
	);
	assert.deepEqual(listSessionFiles(join(f.agentDir, "nope")), []);
});

test("extractMessages: user/assistant text only, short messages and torn tail skipped", async () => {
	const f = makeFixture();
	const messages = await extractMessages(f.fileA);
	assert.deepEqual(
		messages.map((m) => [m.id, m.role]),
		[
			["aa000010", "user"],
			["aa000011", "assistant"],
			["aa000014", "user"],
			["aa000015", "assistant"],
		],
	);
	const all = messages.map((m) => m.text).join("\n");
	assert.ok(!all.includes("THINKSECRET"), "thinking block leaked");
	assert.ok(!all.includes("ARGSECRET"), "tool call arguments leaked");
	assert.ok(!all.includes("TOOLSECRET"), "tool result leaked");
	assert.ok(!all.includes("custom entries"), "custom entry leaked");
	assert.ok(!all.includes("torn"), "torn line leaked");
	assert.equal(messages[1].text, "Agreed: swoole coroutines it is. I will also keep redis as the queue.");
	assert.ok(messages.every((m) => typeof m.timestamp === "number" && m.timestamp > 0));
	assert.ok(messages[0].timestamp < messages[3].timestamp);
});

test("search: AND across terms, ranking, excerpt, session fields", async () => {
	const f = makeFixture();
	const out = await search(f.agentDir, { query: "Swoole COROUTINES", days: 14, exclude: f.fileD });
	assert.equal(out.partial, false);
	assert.deepEqual(out.terms, ["swoole", "coroutines"]);
	// Only session A has both terms (B lacks "coroutines", C is too old, D is excluded).
	assert.deepEqual(
		out.results.map((r) => r.messageId),
		["aa000010", "aa000011"],
	);
	const top = out.results[0];
	assert.equal(top.role, "user", "user message outranks the assistant message with the same hits");
	assert.equal(top.sessionId, ID_A);
	assert.equal(top.shortId, "01a0a001");
	assert.equal(top.file, f.fileA);
	assert.equal(top.cwd, CWD_A);
	assert.equal(top.name, "dialer-plan");
	assert.match(top.date, /^\d{4}-\d{2}-\d{2}$/);
	assert.ok(top.excerpt.toLowerCase().includes("swoole coroutines"));
	assert.ok(!top.excerpt.includes("\n"));
	assert.ok(out.results[0].score > out.results[1].score);
	assert.equal(out.stats.files, 2);
});

test("search: OR fallback is marked partial; recency and cwd filter; limit", async () => {
	const f = makeFixture();
	const partial = await search(f.agentDir, { query: "swoole zzzznotaword", days: 14, exclude: f.fileD });
	assert.equal(partial.partial, true);
	assert.ok(partial.results.length >= 3);
	assert.ok(partial.results.every((r) => r.excerpt.toLowerCase().includes("swoole")));

	const any = await search(f.agentDir, { query: "swoole", days: 14, exclude: f.fileD });
	assert.equal(any.partial, false);
	const sessions = new Set(any.results.map((r) => r.sessionId));
	assert.deepEqual([...sessions].sort(), [ID_A, ID_B].sort());
	assert.ok(!any.results.some((r) => r.sessionId === ID_C), "old session leaked");
	// Two user messages with one hit each: the newer session (A) ranks first.
	const users = any.results.filter((r) => r.role === "user");
	assert.equal(users[0].sessionId, ID_A);
	assert.equal(users[1].sessionId, ID_B);

	const beta = await search(f.agentDir, { query: "swoole", days: 14, cwd: CWD_B, exclude: f.fileD });
	assert.ok(beta.results.length > 0);
	assert.ok(beta.results.every((r) => r.sessionId === ID_B));

	const one = await search(f.agentDir, { query: "swoole", days: 14, limit: 1, exclude: f.fileD });
	assert.equal(one.results.length, 1);

	const none = await search(f.agentDir, { query: "   ", days: 14 });
	assert.deepEqual(none.results, []);
	const nothing = await search(f.agentDir, { query: "unobtainium", days: 14 });
	assert.deepEqual(nothing.results, []);
	assert.equal(nothing.partial, false);
});

test("search: excerpt is clipped around the first hit with ellipses", async () => {
	const f = makeFixture();
	const t = f.now - 30 * 60_000;
	const long = `${"lead ".repeat(100)}NEEDLE in the middle ${"tail ".repeat(100)}`;
	writeSession(f.agentDir, { uuid: "01a0e005-0000-7000-8000-00000000000e", cwd: CWD_A, startedAt: t, entries: [userEntry("ee000010", long, t + 1000)] });
	const out = await search(f.agentDir, { query: "needle", days: 14, exclude: f.fileD });
	assert.equal(out.results[0].messageId, "ee000010");
	const ex = out.results[0].excerpt;
	assert.ok(ex.startsWith("…") && ex.endsWith("…"), ex);
	assert.ok(ex.includes("NEEDLE in the middle"));
	assert.ok(ex.length < 340, `excerpt too long: ${ex.length}`);
});

test("cache: unchanged files hit, an appended line rebuilds that file only", async () => {
	const f = makeFixture();
	const first = await search(f.agentDir, { query: "swoole", days: 14, exclude: f.fileD });
	assert.equal(first.stats.scanned, 2);
	assert.equal(first.stats.cached, 0);
	assert.equal(cacheDirFor(f.agentDir), f.cacheDir);
	assert.ok(existsSync(f.cacheDir));
	assert.equal(readdirSync(f.cacheDir).filter((n) => n.endsWith(".json")).length, 2);

	const second = await search(f.agentDir, { query: "swoole", days: 14, exclude: f.fileD });
	assert.equal(second.stats.scanned, 0);
	assert.equal(second.stats.cached, 2);
	assert.deepEqual(
		second.results.map((r) => r.messageId),
		first.results.map((r) => r.messageId),
	);

	// The torn tail gets completed by the next write, as pi would: newline first.
	appendFileSync(f.fileA, `\n${JSON.stringify({ ...userEntry("aa000020", "Cache rebuild probe: swoole again.", f.now), parentId: "aa000016" })}\n`);
	const third = await search(f.agentDir, { query: "rebuild probe", days: 14, exclude: f.fileD });
	assert.equal(third.stats.scanned, 1);
	assert.equal(third.stats.cached, 1);
	assert.equal(third.results.length, 1);
	assert.equal(third.results[0].messageId, "aa000020");

	// A custom cache dir keeps the default location untouched.
	const custom = join(f.agentDir, "custom-cache");
	const fourth = await search(f.agentDir, { query: "swoole", days: 14, cacheDir: custom, exclude: f.fileD });
	assert.equal(fourth.stats.scanned, 2);
	assert.equal(readdirSync(custom).length, 2);
});

test("read: window around the anchor, offset paging, char cap, id prefix", async () => {
	const f = makeFixture();
	// Anchor on the third message with a 2-message page: starts 2 before → [aa000010, aa000011].
	const page1 = await read(f.agentDir, { sessionId: ID_A, messageId: "aa000014", limit: 2 });
	assert.ok(page1);
	assert.equal(page1.sessionId, ID_A);
	assert.equal(page1.name, "dialer-plan");
	assert.equal(page1.total, 4);
	assert.equal(page1.start, 0);
	assert.equal(page1.count, 2);
	assert.match(page1.lines[0], /^\[user \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] We decided to use swoole coroutines/);
	assert.match(page1.lines[1], /^\[assistant \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Agreed: swoole coroutines/);
	assert.equal(page1.next_offset, 2);
	assert.equal(page1.next_message_id, "aa000014");

	const page2 = await read(f.agentDir, { sessionId: ID_A, offset: page1.next_offset });
	assert.ok(page2);
	assert.equal(page2.start, 2);
	assert.equal(page2.count, 2);
	assert.ok(page2.lines[0].includes("What about redis then?"));
	assert.equal(page2.next_offset, undefined);
	assert.equal(page2.next_message_id, undefined);
	assert.equal(page2.text, page2.lines.join("\n"));

	// Anchor near the start clamps to 0; the default page is 8 messages.
	const page3 = await read(f.agentDir, { sessionId: ID_A, messageId: "aa000011" });
	assert.ok(page3);
	assert.equal(page3.start, 0);
	assert.equal(page3.count, 4);

	// Character cap: a tiny page holds one message and points at the next.
	const capped = await read(f.agentDir, { sessionId: ID_A, pageChars: 100 });
	assert.ok(capped);
	assert.equal(capped.count, 1);
	assert.equal(capped.next_offset, 1);
	assert.equal(capped.next_message_id, "aa000011");

	// The 8-char prefix printed by search resolves; unknown ids do not; bad anchors throw.
	const byPrefix = await read(f.agentDir, { sessionId: "01a0a001" });
	assert.equal(byPrefix?.sessionId, ID_A);
	assert.equal(await read(f.agentDir, { sessionId: "ffffffff" }), undefined);
	await assert.rejects(read(f.agentDir, { sessionId: ID_A, messageId: "nope0000" }), /not in session/);
	// A session outside the read window (60 days) or excluded is not found.
	assert.equal(await read(f.agentDir, { sessionId: ID_C, days: 14 }), undefined);
	assert.equal(await read(f.agentDir, { sessionId: ID_D, exclude: f.fileD }), undefined);
	// Reading by file path works too.
	const byFile = await read(f.agentDir, { file: f.fileB });
	assert.equal(byFile?.sessionId, ID_B);
});

test("search: the current session file is excluded", async () => {
	const f = makeFixture();
	const withCurrent = await search(f.agentDir, { query: "swoole coroutines again", days: 14 });
	assert.ok(withCurrent.results.some((r) => r.sessionId === ID_D));
	const without = await search(f.agentDir, { query: "swoole coroutines again", days: 14, exclude: f.fileD });
	assert.ok(!without.results.some((r) => r.sessionId === ID_D));
});

// ---------------------------------------------------------------------------
// Module: tools in the session role, command in the main session

test("session role: tools registered, no command; search and read through the tool API", async () => {
	const f = makeFixture();
	const pi = new FakePi();
	const kit = kitFor(pi, "session");
	assert.equal(kit.role.role, "session");
	assert.equal(kit.role.isChild, true);
	assert.equal(kit.paths.agentDir, f.agentDir);
	await module.setup(pi as any, kit);

	assert.ok(pi.tools.has("session_search"));
	assert.ok(pi.tools.has("session_read"));
	assert.ok(!pi.commands.has("sessions"), "no /sessions in a child");
	const searchTool = pi.tools.get("session_search")!;
	assert.equal(searchTool.renderShell, "self");
	assert.equal(typeof searchTool.promptSnippet, "string");
	assert.equal(searchTool.promptGuidelines?.length, 1);
	assert.ok(searchTool.promptGuidelines?.[0].includes("session_search"));

	const ctx = makeCtx({ sessionFile: f.fileD });
	const result = await searchTool.execute("1", { query: "swoole coroutines" }, undefined, undefined, ctx);
	const text = result.content[0].text as string;
	const lines = text.split("\n");
	assert.match(lines[0], /^1\. \d{4}-\d{2}-\d{2} alpha \[user\] .*swoole coroutines.*  \(session 01a0a001, msg aa000010\)$/);
	assert.match(lines[1], /^2\. \d{4}-\d{2}-\d{2} alpha \[assistant\] /);
	assert.equal(lines.length, 2, "the current session (D) must not appear");
	assert.equal(result.details.partial, false);
	assert.equal(result.details.results.length, 2);

	// Clamping and the empty case.
	const empty = await searchTool.execute("2", { query: "unobtainium", days: 999, limit: 0 }, undefined, undefined, ctx);
	assert.equal(empty.content[0].text, "No matches in the last 60 days.");

	const readTool = pi.tools.get("session_read")!;
	const page = await readTool.execute("3", { session_id: "01a0a001", message_id: "aa000014" }, undefined, undefined, ctx);
	const pageText = page.content[0].text as string;
	assert.ok(pageText.startsWith(`session ${ID_A} ${CWD_A} "dialer-plan" — messages 1-4 of 4`), pageText.split("\n")[0]);
	assert.ok(pageText.includes("[user "));
	assert.ok(pageText.includes("What about redis then?"));
	assert.ok(!pageText.includes("[more:"));
	assert.equal(page.details.next_offset, undefined);

	const paged = await readTool.execute("4", { session_id: ID_A, offset: 3 }, undefined, undefined, ctx);
	assert.ok((paged.content[0].text as string).includes("messages 4-4 of 4"));
	await assert.rejects(readTool.execute("5", { session_id: "ffffffff" }, undefined, undefined, ctx), /No session matches/);
	await assert.rejects(readTool.execute("6", { session_id: ID_D }, undefined, undefined, ctx), /No session matches/);

	// Frames: FrameTop for the call, FrameBottom (6 lines collapsed) for the result.
	const callCtx = renderContext({ query: "swoole coroutines" });
	const top = searchTool.renderCall!({ query: "swoole coroutines" }, plainTheme, callCtx);
	assert.ok(top instanceof FrameTop);
	const topLines = renderLines(top, 60);
	assert.ok(topLines[0].startsWith("╭─ SESSION SEARCH "), topLines[0]);
	assert.equal(topLines[1], "│ swoole coroutines");
	const many = { content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `${i + 1}. line`).join("\n") }] };
	const bottom = searchTool.renderResult!(many, { expanded: false, isPartial: false }, plainTheme, callCtx);
	assert.ok(bottom instanceof FrameBottom);
	const bottomLines = renderLines(bottom, 60);
	assert.equal(bottomLines.filter((l) => /^│ \d+\. line$/.test(l)).length, 6);
	assert.ok(bottomLines.some((l) => l.includes("+4 lines")));
	assert.ok(bottomLines.every((l) => l.startsWith("│ ")), "no closing border");
	assert.equal(callCtx.state.done, true);
	assert.ok(searchTool.renderCall!({ query: "swoole coroutines" }, plainTheme, callCtx) instanceof FrameTop);
	const readTop = renderLines(readTool.renderCall!({ session_id: "01a0a001", message_id: "aa000014" }, plainTheme, renderContext({})), 60);
	assert.ok(readTop[0].startsWith("╭─ SESSION READ "));
	assert.equal(readTop[1], "│ 01a0a001 @aa000014");
});

test("main session: no tools, /sessions prints a frame; toolsInMain registers the tools", async () => {
	const f = makeFixture();
	const pi = new FakePi();
	const kit = kitFor(pi, undefined);
	assert.equal(kit.role.isChild, false);
	await module.setup(pi as any, kit);
	assert.ok(!pi.tools.has("session_search"));
	assert.ok(!pi.tools.has("session_read"));
	const command = pi.commands.get("sessions");
	assert.ok(command);

	const ctx = makeCtx({ sessionFile: f.fileD });
	await command.handler("swoole coroutines", ctx);
	assert.equal(pi.entries.length, 1);
	const entry = pi.entries[0] as { customType: string; data: any };
	assert.equal(entry.customType, "toolkit-frame");
	assert.equal(entry.data.title, "SESSION SEARCH");
	assert.ok(entry.data.head[0].startsWith("swoole coroutines  (2 sessions"));
	assert.equal(entry.data.lines.length, 2);
	assert.match(entry.data.lines[0], /^1\. .* alpha \[user\] .*\(session 01a0a001, msg aa000010\)$/);
	assert.equal(entry.data.state, "ok");

	await command.handler("   ", ctx);
	assert.equal(pi.entries.length, 1);
	assert.equal(ctx.ui.notifications.at(-1)?.message, "Usage: /sessions <query>");

	const pi2 = new FakePi();
	const kit2 = kitFor(pi2, undefined, { session: { toolsInMain: true } });
	await module.setup(pi2 as any, kit2);
	assert.ok(pi2.tools.has("session_search"));
	assert.ok(pi2.tools.has("session_read"));
	assert.ok(pi2.commands.has("sessions"));
});

test("module metadata", () => {
	assert.equal(module.id, "session");
	assert.equal(module.label, "Session memory");
	assert.equal(module.order, 65);
	assert.deepEqual(module.child, ["session"]);
	assert.equal(module.default, true);
});
