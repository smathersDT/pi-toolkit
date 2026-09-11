import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, plainTheme, tempAgentDir } from "../../../test/harness.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { followUpKeys, install, MAX_ROWS, QUEUE_KEY, widgetLines } from "../index.ts";

const WIDGET = "toolkit-queue";

function setup(host: FakePi = new FakePi(), followUp: string[] = ["alt+enter"]) {
	tempAgentDir();
	const pi = host;
	const kit = createToolkit(pi as any, { modules: {} });
	const { queue } = install(pi as any, kit, { followUpKeys: followUp });
	return { pi, kit, queue };
}

/** A ctx whose editor holds `text` and whose agent is idle or busy. */
function editorCtx(text: string, idle = true) {
	const ctx = makeCtx();
	let current = text;
	ctx.ui.getEditorText = () => current;
	ctx.ui.setEditorText = (t: string) => {
		current = t;
	};
	ctx.isIdle = () => idle;
	return Object.assign(ctx, { editor: () => current });
}

async function shutdown(pi: FakePi, ctx: any) {
	await pi.emit("session_shutdown", { reason: "quit" }, ctx);
}

test("ctrl+q while idle sends the prompt at once and clears the editor", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("fix the tests");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	assert.deepEqual(pi.userMessages, [{ content: "fix the tests", options: { expandPromptTemplates: true } }]);
	assert.equal(ctx.editor(), "");
	assert.equal(queue.size, 0);
	assert.equal(queue.inFlight?.text, "fix the tests");
	assert.equal(ctx.ui.widgets.get(WIDGET), undefined, "a lone prompt in flight shows no panel");
	await shutdown(pi, ctx);
});

test("prompts queue behind the one in flight and drain one per agent_settled", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("one");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	ctx.ui.setEditorText("two");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	ctx.ui.setEditorText("three");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	assert.equal(pi.userMessages.length, 1);
	assert.deepEqual(queue.list().map((i) => i.text), ["two", "three"]);
	const panel = ctx.ui.widgets.get(WIDGET) as string[];
	assert.ok(panel.some((l) => l.includes("sending · 2 waiting")), panel.join("\n"));
	assert.ok(panel.some((l) => l.includes("▶ one")));
	assert.ok(panel.some((l) => l.includes(" 1. two")));

	await pi.emit("input", { text: "one", source: "extension" }, ctx);
	assert.equal(queue.inFlight?.started, true);
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(pi.userMessages.length, 2);
	assert.equal(pi.userMessages[1].content, "two");
	assert.equal(queue.inFlight?.text, "two");
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(pi.userMessages[2].content, "three");
	assert.equal(ctx.ui.widgets.get(WIDGET), undefined, "panel hidden once only one prompt remains in flight");
	await pi.emit("agent_start", {}, ctx);
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(queue.inFlight, undefined);
	assert.equal(pi.userMessages.length, 3);
	await shutdown(pi, ctx);
});

test("a follow-up typed while streaming is taken into the queue; steering passes through", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("", false);
	const [taken] = await pi.emit("input", { text: "later", source: "interactive", streamingBehavior: "followUp" }, ctx);
	assert.deepEqual(taken, { action: "handled" });
	assert.deepEqual(queue.list().map((i) => i.text), ["later"]);
	assert.equal(pi.userMessages.length, 0, "the agent is busy");
	const [steer] = await pi.emit("input", { text: "now", source: "interactive", streamingBehavior: "steer" }, ctx);
	assert.deepEqual(steer, { action: "continue" });
	const [idle] = await pi.emit("input", { text: "plain", source: "interactive" }, ctx);
	assert.deepEqual(idle, { action: "continue" });
	assert.equal(queue.size, 1);
	ctx.isIdle = () => true;
	await pi.emit("agent_settled", {}, ctx);
	assert.equal(pi.userMessages[0].content, "later");
	await shutdown(pi, ctx);
});

test("/queue hold stacks prompts; /queue go releases them", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("");
	const command = pi.commands.get("queue")!.handler;
	await command("hold", ctx);
	assert.equal(queue.held, true);
	ctx.ui.setEditorText("a");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	ctx.ui.setEditorText("b");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	assert.equal(pi.userMessages.length, 0);
	assert.equal(queue.size, 2);
	const panel = ctx.ui.widgets.get(WIDGET) as string[];
	assert.ok(panel.some((l) => l.includes("2 prompts held")), panel.join("\n"));
	await command("go", ctx);
	assert.equal(queue.held, false);
	assert.equal(pi.userMessages[0].content, "a");
	assert.equal(queue.size, 1);
	await shutdown(pi, ctx);
});

test("ctrl+q on an empty prompt releases a held queue", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("");
	queue.held = true;
	queue.push("a");
	await pi.shortcuts.get(QUEUE_KEY)!.handler(ctx);
	assert.equal(queue.held, false);
	assert.equal(pi.userMessages[0].content, "a");
	await shutdown(pi, ctx);
});

test("/queue drop, pop and clear edit a held queue; /queue lists it in a frame", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("");
	const command = pi.commands.get("queue")!.handler;
	await command("hold", ctx);
	for (const text of ["a", "b", "c", "d"]) queue.push(text);
	await command("drop 2", ctx);
	assert.deepEqual(queue.list().map((i) => i.text), ["a", "c", "d"]);
	await command("drop 9", ctx);
	assert.equal(ctx.ui.notifications.at(-1)?.type, "warning");
	await command("pop", ctx);
	assert.deepEqual(queue.list().map((i) => i.text), ["a", "c"]);
	assert.equal(ctx.editor(), "d", "pop puts the prompt back in the editor");
	await command("", ctx);
	const entry = pi.entries.at(-1) as { customType: string; data: { title: string; head: string[]; lines: string[] } };
	assert.equal(entry.customType, "toolkit-frame");
	assert.equal(entry.data.title, "queue");
	assert.deepEqual(entry.data.head, ["2 held"]);
	assert.deepEqual(entry.data.lines, ["1. a", "2. c"]);
	await command("clear", ctx);
	assert.equal(queue.size, 0);
	assert.equal(ctx.ui.widgets.get(WIDGET), undefined);
	await shutdown(pi, ctx);
});

test("a switched session carries queued prompts over, held", async () => {
	const { pi, queue } = setup();
	const ctx = editorCtx("", false);
	queue.push("a");
	queue.push("b");
	queue.takeForSend();
	await pi.emit("session_start", { reason: "new" }, ctx);
	assert.equal(queue.inFlight, undefined);
	assert.deepEqual(queue.list().map((i) => i.text), ["a", "b"]);
	assert.equal(queue.held, true);
	assert.match(ctx.ui.notifications.at(-1)?.message ?? "", /carried over and held/);
	await shutdown(pi, ctx);
});

test("when ctrl+q cannot be registered the module still loads and says so once", async () => {
	class Taken extends FakePi {
		override registerShortcut(): void {
			throw new Error("ctrl+q is bound to app.message.followUp");
		}
	}
	const { pi } = setup(new Taken());
	assert.equal(pi.shortcuts.size, 0);
	const ctx = editorCtx("");
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("session_start", { reason: "reload" }, ctx);
	const warnings = ctx.ui.notifications.filter((n: { message: string }) => n.message.includes("ctrl+q is taken"));
	assert.equal(warnings.length, 1);
	await shutdown(pi, ctx);
});

test("followUpKeys: ctrl+q on Windows and WSL, alt+enter elsewhere, keybindings.json wins", () => {
	const dir = tempAgentDir();
	assert.deepEqual(followUpKeys(dir, "win32", {}), ["ctrl+q"]);
	assert.deepEqual(followUpKeys(dir, "linux", { WSL_DISTRO_NAME: "Ubuntu" }), ["ctrl+q"]);
	assert.deepEqual(followUpKeys(dir, "darwin", {}), ["alt+enter"]);
	writeFileSync(join(dir, "keybindings.json"), '﻿{ "followUp": "ctrl+q" }');
	assert.deepEqual(followUpKeys(dir, "darwin", {}), ["ctrl+q"]);
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ followUp: "ctrl+q", "app.message.followUp": ["Alt+Enter", "ctrl+j"] }));
	assert.deepEqual(followUpKeys(dir, "win32", {}), ["alt+enter", "ctrl+j"]);
});

test("when ctrl+q is pi's follow-up key the shortcut is left to pi, silently, and the hint drops it", async () => {
	const { pi, queue } = setup(new FakePi(), ["ctrl+q"]);
	assert.equal(pi.shortcuts.size, 0);
	const ctx = editorCtx("", false);
	await pi.emit("session_start", { reason: "startup" }, ctx);
	assert.equal(ctx.ui.notifications.length, 0);
	const [result] = await pi.emit("input", { source: "interactive", text: "next", streamingBehavior: "followUp" }, ctx);
	assert.equal(result.action, "handled");
	assert.deepEqual(queue.list().map((i) => i.text), ["next"]);
	queue.held = true;
	const lines = widgetLines({ items: queue.list(), inFlight: undefined, held: true, agentBusy: true }, plainTheme, 80);
	assert.ok(lines[1].includes("/queue go to release"));
	await shutdown(pi, ctx);
});

test("widgetLines: framed, numbered, capped at MAX_ROWS with the head kept visible", () => {
	const items = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: `prompt ${i + 1}\nmore`, queuedAt: 0 }));
	const lines = widgetLines({ items, inFlight: { ...items[0], text: "running", sentAt: 0, started: true }, held: false, agentBusy: true }, plainTheme, 60);
	assert.ok(lines.length <= 10, "pi truncates a widget past 10 lines");
	assert.equal(lines.length, MAX_ROWS + 3);
	assert.ok(lines[0].startsWith("╭─ QUEUE "));
	assert.ok(lines[1].includes("sending · 10 waiting"));
	assert.ok(lines[3].includes("▶ running"));
	assert.ok(lines[4].includes(" 1. prompt 1 (+1 line)"));
	assert.ok(lines.at(-1)!.includes("+6 more"), "no closing border");
	assert.deepEqual(widgetLines({ items: [], inFlight: undefined, held: false, agentBusy: false }, plainTheme, 60), []);
	const held = widgetLines({ items: items.slice(0, 1), inFlight: undefined, held: true, agentBusy: false }, plainTheme, 100);
	assert.ok(held[1].includes("1 prompt held"));
});
