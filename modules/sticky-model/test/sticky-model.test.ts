import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";
import { patch, readSettings, remember } from "../settings.ts";

test("patch sets the default model and reports a no-op as undefined", () => {
	assert.deepEqual(patch({}, { defaultProvider: "anthropic", defaultModel: "claude-x" }), { defaultProvider: "anthropic", defaultModel: "claude-x" });
	assert.equal(patch({ defaultProvider: "anthropic", defaultModel: "claude-x" }, { defaultProvider: "anthropic", defaultModel: "claude-x" }), undefined);
	assert.equal(patch({ theme: "dark" }, {}), undefined);
});

test("patch preserves other keys and merges one model into modelThinkingLevels", () => {
	const current = { theme: "dark", modelThinkingLevels: { "openai/gpt": "low" }, defaultThinkingLevel: "medium" };
	const next = patch(current, { thinkingFor: { key: "anthropic/claude-x", level: "high" } });
	assert.deepEqual(next, { theme: "dark", modelThinkingLevels: { "openai/gpt": "low", "anthropic/claude-x": "high" }, defaultThinkingLevel: "medium" });
	assert.deepEqual(current.modelThinkingLevels, { "openai/gpt": "low" }, "input untouched");
	assert.equal(patch(next!, { thinkingFor: { key: "anthropic/claude-x", level: "high" } }), undefined);
});

test("patch replaces a malformed modelThinkingLevels", () => {
	const next = patch({ modelThinkingLevels: ["nope"] as unknown }, { thinkingFor: { key: "a/b", level: "off" } });
	assert.deepEqual(next?.modelThinkingLevels, { "a/b": "off" });
});

test("remember does read-merge-write on settings.json, creating it when missing", () => {
	const dir = tempAgentDir();
	const file = join(dir, "settings.json");
	assert.equal(remember(file, { defaultProvider: "p", defaultModel: "m" }), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { defaultProvider: "p", defaultModel: "m" });

	writeFileSync(file, JSON.stringify({ theme: "light", defaultProvider: "p", defaultModel: "m", packages: ["x"] }));
	assert.equal(remember(file, { defaultProvider: "p", defaultModel: "m" }), false, "no-op is not written");
	assert.equal(remember(file, { defaultModel: "m2" }), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "light", defaultProvider: "p", defaultModel: "m2", packages: ["x"] });
});

test("remember leaves a malformed settings.json alone", () => {
	const dir = tempAgentDir();
	const file = join(dir, "settings.json");
	writeFileSync(file, "{ not json");
	assert.equal(readSettings(file), undefined);
	assert.equal(remember(file, { defaultModel: "m" }), false);
	assert.equal(readFileSync(file, "utf8"), "{ not json");
});

async function setup() {
	const dir = tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	const read = () => (existsSync(join(dir, "settings.json")) ? JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) : undefined);
	return { pi, read };
}

test("model_select writes the default model, except on restore", async () => {
	const { pi, read } = await setup();
	await pi.emit("model_select", { model: { provider: "anthropic", id: "claude-x" }, source: "restore" }, makeCtx());
	assert.equal(read(), undefined);
	await pi.emit("model_select", { model: { provider: "anthropic", id: "claude-x" }, source: "set" }, makeCtx());
	assert.deepEqual(read(), { defaultProvider: "anthropic", defaultModel: "claude-x" });
});

test("thinking_level_select on the current model writes both the per-model and the global level", async () => {
	const { pi, read } = await setup();
	const model = { provider: "anthropic", id: "claude-x", reasoning: true };
	await pi.emit("session_start", { reason: "startup" }, makeCtx({ model }));
	await pi.emit("thinking_level_select", { level: "high", previousLevel: "medium" }, makeCtx({ model }));
	assert.deepEqual(read(), { modelThinkingLevels: { "anthropic/claude-x": "high" }, defaultThinkingLevel: "high" });
});

test("a level resolved for an incoming model does not move the global default; a non-reasoning model never does", async () => {
	const { pi, read } = await setup();
	await pi.emit("session_start", { reason: "startup" }, makeCtx({ model: { provider: "anthropic", id: "claude-x", reasoning: true } }));
	const incoming = { provider: "openai", id: "gpt", reasoning: true };
	await pi.emit("thinking_level_select", { level: "low", previousLevel: "high" }, makeCtx({ model: incoming }));
	assert.deepEqual(read(), { modelThinkingLevels: { "openai/gpt": "low" } });
	await pi.emit("model_select", { model: incoming, source: "cycle" }, makeCtx({ model: incoming }));
	const plain = { provider: "openai", id: "gpt", reasoning: false };
	await pi.emit("thinking_level_select", { level: "off", previousLevel: "low" }, makeCtx({ model: plain }));
	assert.deepEqual(read(), { modelThinkingLevels: { "openai/gpt": "off" }, defaultProvider: "openai", defaultModel: "gpt" });
});
