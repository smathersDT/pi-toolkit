import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createToolkit } from "../../../core/kit.ts";
import { writeJsonAtomic } from "../../../core/paths.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import { historyFile } from "../history.ts";
import module, { attachHistory, HistoryEditor } from "../index.ts";

/** The slice of pi's TUI, theme and keybindings an Editor touches at construction. */
const tui: any = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const theme: any = { borderColor: (s: string) => s, selectList: {} };
const keybindings: any = { matches: () => false, getKeys: () => [] };

function stored(file: string): string[] {
	return JSON.parse(readFileSync(file, "utf8"));
}

test("HistoryEditor preloads the on-disk history and persists every submitted prompt", () => {
	const file = historyFile(tempAgentDir());
	writeJsonAtomic(file, ["older", "/cmd", "oldest"]);
	const editor = new HistoryEditor(tui, theme, keybindings, file);
	assert.equal(editor.historySupported, true, "pi's Editor still exposes its history list");
	const history = (editor as unknown as { history: string[] }).history;
	assert.deepEqual(history, ["older", "oldest"]);

	editor.addToHistory("  new prompt  ");
	assert.deepEqual(history, ["new prompt", "older", "oldest"]);
	assert.deepEqual(stored(file), ["new prompt", "older", "oldest"]);

	editor.addToHistory("new prompt");
	assert.deepEqual(history, ["new prompt", "older", "oldest"], "a repeat of the newest is not stored twice");

	for (const command of ["/clear", "/costs report 2d", "  /model x", "/compact\nkeep the summary"]) editor.addToHistory(command);
	editor.addToHistory("   ");
	assert.deepEqual(history, ["new prompt", "older", "oldest"]);
	assert.deepEqual(stored(file), ["new prompt", "older", "oldest"]);
});

test("attachHistory gives another extension's editor the same treatment", () => {
	const file = historyFile(tempAgentDir());
	writeJsonAtomic(file, ["from disk"]);
	const editor = new CustomEditor(tui, theme, keybindings);
	assert.equal(attachHistory(editor, file), true);
	assert.deepEqual((editor as unknown as { history: string[] }).history, ["from disk"]);
	editor.addToHistory("typed");
	assert.deepEqual(stored(file), ["typed", "from disk"]);
	editor.addToHistory("/new");
	assert.deepEqual(stored(file), ["typed", "from disk"]);
});

test("an editor without the history field degrades to its own addToHistory", () => {
	const file = historyFile(tempAgentDir());
	const calls: string[] = [];
	const foreign = { addToHistory: (text: string) => calls.push(text) };
	assert.equal(attachHistory(foreign, file), false);
	foreign.addToHistory("kept in memory");
	assert.deepEqual(calls, ["kept in memory"]);
});

async function setup() {
	const dir = tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	return { pi, file: historyFile(dir) };
}

/** A TUI ctx that stores the editor factory like pi does. */
function editorCtx(previous?: unknown) {
	const ctx = makeCtx();
	let factory: any = previous;
	ctx.ui.getEditorComponent = () => factory;
	ctx.ui.setEditorComponent = (f: any) => {
		factory = f;
	};
	return Object.assign(ctx, { factory: () => factory });
}

test("session_start installs the editor factory once, in tui mode only", async () => {
	const { pi, file } = await setup();
	writeJsonAtomic(file, ["saved"]);
	const print = editorCtx();
	print.mode = "print";
	await pi.emit("session_start", { reason: "startup" }, print);
	assert.equal(print.factory(), undefined);

	const ctx = editorCtx();
	await pi.emit("session_start", { reason: "startup" }, ctx);
	const factory = ctx.factory();
	assert.equal(typeof factory, "function");
	const editor = factory(tui, theme, keybindings);
	assert.ok(editor instanceof HistoryEditor);
	assert.deepEqual((editor as unknown as { history: string[] }).history, ["saved"]);
	assert.deepEqual(ctx.ui.notifications, []);

	await pi.emit("session_start", { reason: "reload" }, ctx);
	assert.equal(ctx.factory(), factory, "not replaced on a second session");
});

test("a previously set editor factory is composed with, not replaced", async () => {
	const { pi, file } = await setup();
	writeJsonAtomic(file, ["saved"]);
	let built = 0;
	const previous = (t: unknown, th: unknown, kb: unknown) => {
		built++;
		return new CustomEditor(t as any, th as any, kb as any);
	};
	const ctx = editorCtx(previous);
	await pi.emit("session_start", { reason: "startup" }, ctx);
	assert.notEqual(ctx.factory(), previous);
	const editor = ctx.factory()(tui, theme, keybindings);
	assert.equal(built, 1);
	assert.ok(!(editor instanceof HistoryEditor));
	assert.deepEqual((editor as unknown as { history: string[] }).history, ["saved"]);
	editor.addToHistory("through the wrapper");
	assert.deepEqual(stored(file), ["through the wrapper", "saved"]);
});

test("a reload finds our own factory and leaves it alone", async () => {
	const { pi } = await setup();
	const ctx = editorCtx();
	await pi.emit("session_start", { reason: "startup" }, ctx);
	const ours = ctx.factory();
	const { pi: reloaded } = await setup();
	const again = editorCtx(ours);
	await reloaded.emit("session_start", { reason: "reload" }, again);
	assert.equal(again.factory(), ours);
});
