import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildChildCommand, runChild } from "../spawn.ts";
import { usageTokens } from "../usage.ts";

const FAKE = fileURLToPath(new URL("./fake-child.mjs", import.meta.url));

function run(scenario: string, overrides: Partial<Parameters<typeof runChild>[0]> = {}) {
	return runChild({
		command: process.execPath,
		args: [FAKE, "--scenario", scenario],
		cwd: process.cwd(),
		env: process.env,
		maxTurns: 10,
		maxTokens: 100_000,
		timeoutSec: 30,
		...overrides,
	});
}

test("buildChildCommand: pi flags, role env and caps", () => {
	const { command, args, env } = buildChildCommand(
		{
			cliPath: "/pi/cli.js",
			nodePath: "/usr/bin/node",
			extensionEntry: "/ext/index.ts",
			cwd: "/work",
			role: "worker",
			task: "do it",
			model: "deepseek/deepseek-v4-flash",
			thinking: "low",
			tools: ["read", "edit"],
			appendSystemPrompt: "You are a worker.",
			depth: 1,
			maxTurns: 40,
			maxTokens: 1_000_000,
			ownedFiles: ["src/a.ts"],
		},
		{ PATH: "/bin", PI_CODING_AGENT_DIR: "/agent" },
	);
	assert.equal(command, "/usr/bin/node");
	assert.equal(args[0], "/pi/cli.js");
	for (const flag of ["--mode", "-p", "--no-extensions", "-e", "--no-session", "--no-skills", "--no-prompt-templates", "--model", "--thinking", "--tools", "--append-system-prompt", "--"]) {
		assert.ok(args.includes(flag), `has ${flag}`);
	}
	assert.equal(args[args.indexOf("--mode") + 1], "json");
	assert.equal(args[args.indexOf("-e") + 1], "/ext/index.ts");
	assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
	assert.equal(args[args.indexOf("--tools") + 1], "read,edit");
	assert.equal(args[args.length - 1], "do it");
	assert.equal(env.PI_TOOLKIT_ROLE, "worker");
	assert.equal(env.PI_TOOLKIT_DEPTH, "1");
	assert.equal(env.PI_TOOLKIT_MAX_TURNS, "40");
	assert.equal(env.PI_TOOLKIT_MAX_TOKENS, "1000000");
	assert.equal(env.PI_TOOLKIT_OWNED_FILES, '["src/a.ts"]');
	assert.equal(env.PI_CODING_AGENT_DIR, "/agent", "inherits the base env");
});

test("a normal run: turns, summed usage, last assistant text, progress lines", async () => {
	const progress: string[] = [];
	const outcome = await run("ok", { onProgress: (line) => progress.push(line) });
	assert.equal(outcome.turns, 2);
	assert.equal(outcome.usage.input, 300);
	assert.equal(outcome.usage.output, 70);
	assert.equal(usageTokens(outcome.usage), 370);
	assert.ok(Math.abs(outcome.usage.cost.total - (300 + 70 * 4) / 1e6) < 1e-12);
	assert.equal(outcome.report, "Final report: all good.\nEvidence: src/a.ts:12");
	assert.equal(outcome.stopReason, "stop");
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.killed, undefined);
	assert.deepEqual(progress, ["turn 1", "turn 1 · bash git log --oneline -3", "turn 1 · bash git log --oneline -3 ✓", "turn 2 · last: bash git log --oneline -3 ✓"]);
});

test("the child gets the role env and the args", async () => {
	const { command, args, env } = buildChildCommand({ cliPath: FAKE, extensionEntry: "/ext/index.ts", cwd: process.cwd(), role: "finder", task: "find x", model: "a/b", thinking: "off", tools: ["grep"], appendSystemPrompt: "p", depth: 2, maxTurns: 8, maxTokens: 120_000 });
	const outcome = await runChild({ command, args: [...args, "--scenario", "env"], cwd: process.cwd(), env, maxTurns: 8, maxTokens: 120_000, timeoutSec: 30 });
	const seen = JSON.parse(outcome.report) as { env: Record<string, string>; argv: string[] };
	assert.equal(seen.env.PI_TOOLKIT_ROLE, "finder");
	assert.equal(seen.env.PI_TOOLKIT_DEPTH, "2");
	assert.equal(seen.env.PI_TOOLKIT_MAX_TURNS, "8");
	assert.equal(seen.env.PI_TOOLKIT_OWNED_FILES, "[]");
	assert.equal(seen.argv[seen.argv.indexOf("--append-system-prompt") + 1], "p");
	assert.equal(seen.argv[seen.argv.indexOf("--") + 1], "find x");
});

test("a failing child with no assistant text rejects with the stderr tail", async () => {
	await assert.rejects(run("fail"), (error: Error & { outcome?: { exitCode: number } }) => {
		assert.match(error.message, /exited with code 2/);
		assert.match(error.message, /no API key/);
		assert.equal(error.outcome?.exitCode, 2);
		return true;
	});
});

test("an error stopReason without text rejects with the child's message", async () => {
	await assert.rejects(run("error-message"), /rate limited/);
});

test("turn cap: the child is killed and what was collected comes back", async () => {
	const outcome = await run("many-turns", { maxTurns: 3 });
	assert.match(outcome.killed ?? "", /turn cap/);
	assert.equal(outcome.stopReason, "killed");
	assert.ok(outcome.turns >= 6, `killed after maxTurns + 2 (${outcome.turns})`);
	assert.ok(outcome.turns < 100, "did not run to the end");
	assert.match(outcome.report, /^turn \d+ text$/);
	assert.equal(outcome.usage.input, outcome.turns * 10);
});

test("token cap: a child still calling tools far past the cap is killed", async () => {
	const outcome = await run("big-usage", { maxTokens: 1_000_000 });
	assert.match(outcome.killed ?? "", /token cap/);
	assert.equal(outcome.report, "partial findings");
	assert.ok(outcome.durationMs < 8000, "killed well before the child's own 10s exit");
});

test("token cap: a final report past the cap is never killed", async () => {
	const outcome = await run("big-final", { maxTokens: 250_000 });
	assert.equal(outcome.killed, undefined);
	assert.equal(outcome.stopReason, "stop");
	assert.equal(outcome.report, "full report");
});

test("token cap: the kill line leaves two turns of the current size past the cap", async () => {
	// 40k a turn on a 100k cap: 120 % would kill at 160k; the line is 100k + 2 × 40k.
	const outcome = await run("steady", { maxTokens: 100_000 });
	assert.equal(outcome.killed, "token cap (200000 > 180000)");
});

test("timeout kills the child", async () => {
	const outcome = await run("many-turns", { timeoutSec: 1, maxTurns: 1000 });
	assert.match(outcome.killed ?? "", /timeout after 1s/);
	assert.ok(outcome.durationMs < 5000);
});

test("abort signal kills the child", async () => {
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 100);
	const outcome = await run("many-turns", { signal: ac.signal });
	assert.equal(outcome.killed, "aborted");
	assert.ok(outcome.durationMs < 5000);
});
