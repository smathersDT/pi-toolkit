import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempAgentDir } from "../../../test/harness.ts";
import { modelKey, pickCheapModel, resolveModel } from "../models.ts";
import { DEFAULT_CONFIG, DEFAULT_ROLES, effectiveTokenCap, loadSubagentsConfig, MIN_TOKEN_CAP, mergeSubagentsConfig, raisedTokenCap, subagentsConfigPath } from "../roles.ts";

test("defaults: eight roles with the documented caps", () => {
	assert.deepEqual(Object.keys(DEFAULT_ROLES), ["researcher", "scout", "finder", "git", "web", "test", "worker", "session"]);
	assert.equal(DEFAULT_ROLES.researcher.model, "inherit");
	assert.equal(DEFAULT_ROLES.researcher.maxTurns, 25);
	assert.equal(DEFAULT_ROLES.researcher.maxTokens, 600_000);
	assert.deepEqual(DEFAULT_ROLES.finder.tools, ["grep", "find", "ls", "read"]);
	assert.equal(DEFAULT_ROLES.worker.maxTokens, 1_000_000);
	assert.deepEqual(DEFAULT_ROLES.web.tools, ["web_search", "web_fetch"]);
	assert.equal(DEFAULT_CONFIG.maxParallel, 4);
	assert.equal(DEFAULT_CONFIG.defaultTimeoutSec, 900);
	for (const role of Object.values(DEFAULT_ROLES)) assert.ok(role.prompt.length > 40, "every role has a prompt");
});

test("token caps: never under 250k, none on a local model", () => {
	assert.equal(MIN_TOKEN_CAP, 250_000);
	for (const role of Object.values(DEFAULT_ROLES)) assert.ok(role.maxTokens >= MIN_TOKEN_CAP, "defaults sit at or above the floor");
	assert.equal(effectiveTokenCap(5000, false), 250_000, "an output-sized override is raised");
	assert.equal(effectiveTokenCap(600_000, false), 600_000);
	assert.equal(effectiveTokenCap(5000, true), 0);
	assert.equal(effectiveTokenCap(1_000_000, true), 0);
	assert.equal(raisedTokenCap(600_000, 250_000), 600_000, "a caller cannot lower the role's cap");
	assert.equal(raisedTokenCap(600_000, 900_000), 900_000);
	assert.equal(raisedTokenCap(250_000, undefined), 250_000);
});

test("loadSubagentsConfig writes the defaults on first use", () => {
	const dir = tempAgentDir();
	const path = subagentsConfigPath(join(dir, "toolkit"));
	assert.equal(existsSync(path), false);
	const cfg = loadSubagentsConfig(path);
	assert.equal(existsSync(path), true);
	assert.deepEqual(cfg, DEFAULT_CONFIG);
	assert.notEqual(cfg.roles, DEFAULT_CONFIG.roles, "a copy, not the shared object");
});

test("file overrides merge over the defaults, unknown roles get a base", () => {
	const dir = tempAgentDir();
	mkdirSync(join(dir, "toolkit"), { recursive: true });
	const path = subagentsConfigPath(join(dir, "toolkit"));
	writeFileSync(
		path,
		JSON.stringify({
			cheapModels: ["x/y"],
			maxParallel: 2,
			roles: {
				researcher: { maxTurns: 5, thinking: "bogus", model: "anthropic/claude-haiku-4-5" },
				reviewer: { tools: ["read", "grep"], prompt: "Review it.", maxTokens: 50_000 },
				"bad name!": { maxTurns: 1 },
			},
		}),
	);
	const cfg = loadSubagentsConfig(path);
	assert.deepEqual(cfg.cheapModels, ["x/y"]);
	assert.equal(cfg.maxParallel, 2);
	assert.equal(cfg.defaultTimeoutSec, 900);
	assert.equal(cfg.roles.researcher.maxTurns, 5);
	assert.equal(cfg.roles.researcher.thinking, "medium", "invalid thinking level ignored");
	assert.equal(cfg.roles.researcher.model, "anthropic/claude-haiku-4-5");
	assert.deepEqual(cfg.roles.researcher.tools, DEFAULT_ROLES.researcher.tools);
	assert.equal(cfg.roles.reviewer.model, "cheap");
	assert.equal(cfg.roles.reviewer.maxTurns, 10);
	assert.equal(cfg.roles.reviewer.maxTokens, 50_000);
	assert.deepEqual(cfg.roles.reviewer.tools, ["read", "grep"]);
	assert.equal("bad name!" in cfg.roles, false);
	assert.equal(DEFAULT_ROLES.researcher.maxTurns, 25, "defaults untouched");
});

test("mergeSubagentsConfig tolerates garbage", () => {
	assert.deepEqual(mergeSubagentsConfig(DEFAULT_CONFIG, undefined), DEFAULT_CONFIG);
	assert.deepEqual(mergeSubagentsConfig(DEFAULT_CONFIG, [1, 2]), DEFAULT_CONFIG);
	assert.deepEqual(mergeSubagentsConfig(DEFAULT_CONFIG, { roles: "no", maxParallel: -3, cheapModels: "x" }), DEFAULT_CONFIG);
});

const current = { provider: "anthropic", id: "claude-opus-4", reasoning: true, cost: { input: 15, output: 75 } };
const available = [
	current,
	{ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true, cost: { input: 0.14, output: 0.28 } },
	{ provider: "local", id: "tiny", reasoning: false, cost: { input: 0.01, output: 0.02 } },
	{ provider: "openai", id: "gpt-5-mini", reasoning: true, cost: { input: 0.25, output: 2 } },
];

test("model resolution: inherit, cheap preference list, cheapest fallback", () => {
	assert.equal(resolveModel("inherit", { current, available, cheapModels: [] }), current);
	assert.equal(resolveModel(undefined, { current, available, cheapModels: [] }), current);
	const cheap = resolveModel("cheap", { current, available, cheapModels: ["openai-codex/none", "deepseek/deepseek-v4-flash", "local/tiny"] });
	assert.equal(modelKey(cheap), "deepseek/deepseek-v4-flash", "first available entry of the preference list wins");
	assert.equal(modelKey(pickCheapModel({ current, available, cheapModels: ["nobody/home"] })), "local/tiny", "cheapest by input+output when nothing listed is available");
	assert.equal(pickCheapModel({ current, available: [], cheapModels: [] }), current, "falls back to the parent's model");
	assert.throws(() => pickCheapModel({ current: undefined, available: [], cheapModels: [] }), /no model available/);
});

test("model resolution: provider/id, bare id, and clear errors", () => {
	assert.equal(modelKey(resolveModel("openai/gpt-5-mini", { current, available, cheapModels: [] })), "openai/gpt-5-mini");
	let asked: string[] = [];
	const found = resolveModel("acme/x", {
		current,
		available,
		cheapModels: [],
		find: (p, id) => {
			asked = [p, id];
			return { provider: p, id, cost: { input: 1, output: 1 } };
		},
	});
	assert.deepEqual(asked, ["acme", "x"]);
	assert.equal(modelKey(found), "acme/x");
	assert.equal(modelKey(resolveModel("tiny", { current, available, cheapModels: [] })), "local/tiny", "bare id");
	assert.throws(() => resolveModel("nope/x", { current, available, cheapModels: [] }), /not available.*deepseek\/deepseek-v4-flash/);
	assert.throws(() => resolveModel("inherit", { current: undefined, available, cheapModels: [] }), /no model selected/);
	assert.throws(() => resolveModel("claude-opus-4", { current, available: [current, { ...current, provider: "github-copilot" }], cheapModels: [] }), /ambiguous/);
});
