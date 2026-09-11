import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";
import { compactInput, foldOutsideFences, isSlashCommand } from "../input.ts";

test("slash commands pass through untouched", () => {
	assert.equal(isSlashCommand("/toolkit stats"), true);
	assert.equal(isSlashCommand("  /skill:foo   \n\n\n\n\n"), true);
	assert.equal(isSlashCommand("a/b"), false);
	assert.equal(compactInput("/compact      \n\n\n\n\n\n"), undefined);
});

test("hygiene: ANSI, CRLF, trailing spaces and blank-line runs", () => {
	const text = "[31mError[0m here   \r\nnext   \r\n\r\n\r\n\r\n\r\nafter";
	const r = compactInput(text);
	assert.ok(r);
	assert.equal(r.text, "Error here\nnext\n\nafter");
	assert.ok(r.after <= r.before * 0.95);
	// Two blank lines are not three: kept.
	assert.equal(compactInput("a\n\n\nb"), undefined);
});

test("below a 5% saving the prompt is left alone", () => {
	const text = `${"a fairly long sentence that the user typed by hand ".repeat(4)} `;
	assert.equal(compactInput(text), undefined);
});

test("identical lines fold outside fences only", () => {
	const prose = ["same", "same", "same", "same", "other"].join("\n");
	assert.equal(foldOutsideFences(prose), "same\n[+3 identical lines]\nother");
	const code = "```ts\nx();\nx();\nx();\nx();\n```";
	assert.equal(foldOutsideFences(code), code);
	const mixed = `${prose}\n${code}\n${prose}`;
	const folded = foldOutsideFences(mixed);
	assert.equal(folded, `same\n[+3 identical lines]\nother\n${code}\nsame\n[+3 identical lines]\nother`);
	// Unclosed fence: everything after the opener is code.
	const open = "intro\n```\nsame\nsame\nsame\nsame";
	assert.equal(foldOutsideFences(open), open);
});

test("large pasted JSON becomes TOON; small JSON stays", () => {
	const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `user${i}`, active: true }));
	const big = compactInput(JSON.stringify(rows, null, 2));
	assert.ok(big);
	assert.ok(big.text.startsWith("[20]{id,name,active}:"));
	const small = JSON.stringify(rows.slice(0, 3), null, 2);
	assert.ok(Buffer.byteLength(small) < 400);
	assert.equal(compactInput(small), undefined);
	// With toon off the JSON is left alone even when large.
	assert.equal(compactInput(JSON.stringify(rows, null, 2), { toon: false }), undefined);
});

test("code pasted by the user changes only in whitespace", () => {
	const code = "```js\nconst a = 1;   \nconst b = 2;\n\n\n\n\n\nconst c = 3;\n```";
	const r = compactInput(code);
	assert.ok(r);
	assert.equal(r.text, "```js\nconst a = 1;\nconst b = 2;\n\nconst c = 3;\n```");
});

test("module hook: transforms interactive input only and records the ledger", async () => {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	const text = "hello   \n\n\n\n\n\nworld   ";
	const [interactive] = await pi.emit("input", { text, source: "interactive" }, makeCtx());
	assert.deepEqual(interactive, { action: "transform", text: "hello\n\nworld" });
	const [ext] = await pi.emit("input", { text, source: "extension" }, makeCtx());
	assert.equal(ext, undefined);
	const [slash] = await pi.emit("input", { text: "/toolkit     \n\n\n\n\n", source: "interactive" }, makeCtx());
	assert.equal(slash, undefined);
	assert.equal(new Map(kit.ledger.entries()).get("compact:input")?.count, 1);
});
