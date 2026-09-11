import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import { BUDGET_STOP, GATE_STOP, TOKEN_CAP_STEER, TURN_CAP_STEER } from "../child.ts";
import { checkGate, isGitCommand, isOwnedPath, isTestCommand, parseAllow, shellWriteTargets } from "../gates.ts";
import module from "../index.ts";

const cwd = process.cwd();

test("git gate: read-only git only, cd and filters allowed", () => {
	for (const ok of [
		"git log --oneline -5",
		"git blame src/a.ts",
		"git show abc123 -- src/a.ts",
		"git diff HEAD~1",
		"cd packages/core && git log -3",
		"git log | head -20",
		"git log --all | grep fix | wc -l",
		"git -C sub --no-pager log -1",
		"git branch -a",
		"git tag -l",
		"git stash list",
		"git remote -v",
		"git config --get user.name",
		"GIT_PAGER=cat git log -1",
	]) {
		assert.equal(isGitCommand(ok), true, ok);
		assert.equal(checkGate("bash", { command: ok }, { role: "git", ownedFiles: [], cwd }), undefined, ok);
	}
	for (const bad of ["ls -la", "echo hi", "git log && rm -rf x", "git push origin main", "git checkout -- .", "git commit -m x", "git reset --hard", "git branch -D old", "git tag v1", "git stash pop", "git config user.name x", "git log | sh", "cd x", ""]) {
		assert.equal(isGitCommand(bad), false, bad);
		const gate = checkGate("bash", { command: bad }, { role: "git", ownedFiles: [], cwd });
		assert.equal(gate?.block, true, bad);
		assert.match(gate?.reason ?? "", /read-only git/);
	}
	assert.equal(checkGate("read", { path: "x" }, { role: "git", ownedFiles: [], cwd }), undefined, "other tools pass");
});

test("test gate: test runners only, optionally after cd", () => {
	for (const ok of [
		"npm test",
		"npm run test:unit",
		"npm t",
		"pnpm test -- --run",
		"yarn test",
		"npx vitest run src/a.test.ts",
		"npx jest --ci",
		"npx mocha test/",
		"pytest tests/test_x.py -k foo",
		"python -m pytest",
		"go test ./...",
		"cargo test --workspace",
		"mvn -q test",
		"./gradlew test --tests Foo",
		"gradle test",
		"php artisan test --filter=Foo",
		"vendor/bin/phpunit tests/Unit",
		"node --test modules/",
		"dotnet test MySolution.sln",
		"cd packages/api && npm test",
		"cd api; pytest",
		"CI=1 npm test | tail -50",
		"pwsh tests/run.ps1",
		"pwsh -NoProfile -File tests/run.ps1 tests/unit/ApiTest.php && pwsh -NoProfile -File tests/run.ps1 tests/unit/GeneralTest.php",
		'powershell.exe -Command "Get-ChildItem tests | Select-Object Name; exit 0"',
		"node --check src/lib/analytics.js",
		"php -l src/api/GeneralApi.php",
		"git diff --check",
		"npx tsc --noEmit -p .",
	]) {
		assert.equal(isTestCommand(ok), true, ok);
	}
	for (const bad of ["npm install", "rm -rf node_modules", "npm test && rm x", "cd x", "node script.js", "npx tsc", "python app.py", "npm test | sh", "cat package.json", ""]) {
		assert.equal(isTestCommand(bad), false, bad);
		assert.equal(checkGate("bash", { command: bad }, { role: "test", ownedFiles: [], cwd })?.block, true, bad);
	}
	assert.equal(checkGate("bash", { command: "npm test" }, { role: "test", ownedFiles: [], cwd }), undefined);
	assert.equal(isTestCommand('pwsh -Command "x" | sh'), false, "a quoted pipe stays inside pwsh, a real one does not");
	assert.equal(isTestCommand("pwsh tests/run.ps1; if ($LASTEXITCODE -ne 0) { exit 1 }"), false, "PowerShell syntax outside pwsh is still bash");
});

test("allow patterns from the role let extra commands through, invalid ones are skipped", () => {
	const allow = parseAllow(JSON.stringify(["^make check(\s|$)", "(unclosed"]));
	assert.equal(allow.length, 1);
	assert.equal(isTestCommand("make check", allow), true);
	assert.equal(isTestCommand("make install", allow), false);
	assert.equal(checkGate("bash", { command: "cd api && make check" }, { role: "test", ownedFiles: [], cwd, allow }), undefined);
	assert.equal(isGitCommand("git log -1 && make check", allow), true);
	assert.deepEqual(parseAllow("not json"), []);
});

test("worker gate: edit/write only inside ownedFiles (files and directories)", () => {
	const ctx = { role: "worker", ownedFiles: ["src/a.ts", "src/gen/"], cwd };
	assert.equal(isOwnedPath("src/a.ts", ctx), true);
	assert.equal(isOwnedPath(join(cwd, "src", "a.ts"), ctx), true, "absolute");
	assert.equal(isOwnedPath("@src/a.ts", ctx), true, "leading @ stripped");
	assert.equal(isOwnedPath("src/gen/x/y.ts", ctx), true, "inside an owned directory");
	assert.equal(isOwnedPath("src/gen", ctx), true);
	assert.equal(isOwnedPath("src/a.ts.bak", ctx), false);
	assert.equal(isOwnedPath("src/b.ts", ctx), false);
	assert.equal(isOwnedPath("src/genx/y.ts", ctx), false, "prefix of a directory is not the directory");
	assert.equal(isOwnedPath(join(tmpdir(), "scratch.txt"), ctx), true, "temp dir is always fine");
	assert.equal(checkGate("edit", { path: "src/a.ts" }, ctx), undefined);
	assert.equal(checkGate("write", { path: "src/gen/new.ts" }, ctx), undefined);
	const blocked = checkGate("edit", { path: "src/b.ts" }, ctx);
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /owned files \(src\/a\.ts, src\/gen\/\)/);
	assert.equal(checkGate("write", {}, ctx)?.block, true, "no path is not owned");
	assert.equal(checkGate("read", { path: "src/b.ts" }, ctx), undefined, "reading anything is fine");
});

test("worker gate: detectable shell writes must target owned files or the temp dir", () => {
	const ctx = { role: "worker", ownedFiles: ["src/a.ts", "out/"], cwd };
	assert.deepEqual(shellWriteTargets("echo hi > out/log.txt 2>&1"), ["out/log.txt"]);
	assert.deepEqual(shellWriteTargets("cmd >> 'my file.txt'"), ["my file.txt"]);
	assert.deepEqual(shellWriteTargets("cmd 2>/dev/null > NUL"), []);
	assert.deepEqual(shellWriteTargets("sed -i 's/a/b/' src/a.ts src/b.ts"), ["src/a.ts", "src/b.ts"]);
	assert.deepEqual(shellWriteTargets("sed -i.bak -e 's/a/b/' src/a.ts"), ["src/a.ts"]);
	assert.deepEqual(shellWriteTargets("sed 's/a/b/' src/a.ts"), [], "sed without -i reads");
	assert.deepEqual(shellWriteTargets("rm -f src/b.ts && mv a b"), ["src/b.ts", "a", "b"]);
	assert.deepEqual(shellWriteTargets("cp -r src/a.ts out/copy.ts"), ["out/copy.ts"]);
	assert.deepEqual(shellWriteTargets("cat x | tee out/t.txt"), ["out/t.txt"]);
	for (const ok of ["cat src/b.ts", "echo hi > out/log.txt", "sed -i 's/a/b/' src/a.ts", "rm out/old.txt", `cp src/a.ts ${join(tmpdir(), "a.ts")}`, "npm test 2>&1 | tail -5", "ls > /dev/null"]) {
		assert.equal(checkGate("bash", { command: ok }, ctx), undefined, ok);
	}
	for (const bad of ["echo hi > src/b.ts", "sed -i 's/a/b/' src/b.ts", "rm -rf node_modules", "mv src/a.ts src/c.ts", "cp src/a.ts src/d.ts", "cat x | tee README.md"]) {
		const gate = checkGate("bash", { command: bad }, ctx);
		assert.equal(gate?.block, true, bad);
		assert.match(gate?.reason ?? "", /outside the owned files/);
	}
	assert.equal(checkGate("bash", { command: "rm -rf x" }, { role: "researcher", ownedFiles: [], cwd }), undefined, "no gate for other roles");
});

async function childSetup(role: string, caps: { maxTurns?: number; maxTokens?: number }, ownedFiles?: string[]) {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	kit.role = { isChild: true, role, depth: 1, maxTurns: caps.maxTurns, maxTokens: caps.maxTokens };
	delete process.env.PI_TOOLKIT_ALLOW;
	const previous = process.env.PI_TOOLKIT_OWNED_FILES;
	if (ownedFiles) process.env.PI_TOOLKIT_OWNED_FILES = JSON.stringify(ownedFiles);
	else delete process.env.PI_TOOLKIT_OWNED_FILES;
	try {
		await module.setup(pi as any, kit);
	} finally {
		if (previous === undefined) delete process.env.PI_TOOLKIT_OWNED_FILES;
		else process.env.PI_TOOLKIT_OWNED_FILES = previous;
	}
	return { pi, kit, ctx: makeCtx({ mode: "json" }) };
}

const toolCall = (pi: FakePi, ctx: any, toolName = "read", input: unknown = { path: "x" }) => pi.emit("tool_call", { toolName, toolCallId: "t", input }, ctx).then((r) => r[0]);

test("child: no delegate tool, steer at maxTurns - 1, block at maxTurns", async () => {
	const { pi, ctx } = await childSetup("researcher", { maxTurns: 3 });
	assert.equal(pi.tools.has("delegate"), false);
	assert.equal(pi.commands.has("subagents"), false);
	await pi.emit("turn_start", { turnIndex: 0 }, ctx);
	assert.equal(await toolCall(pi, ctx), undefined);
	assert.equal(pi.sent.length, 0);
	await pi.emit("turn_start", { turnIndex: 1 }, ctx);
	assert.equal(pi.sent.length, 1, "steer at turn 2 of 3");
	assert.deepEqual(pi.sent[0], { message: { customType: "toolkit-cap", content: TURN_CAP_STEER, display: false }, options: { deliverAs: "steer" } });
	assert.equal(await toolCall(pi, ctx), undefined, "turn 2 still runs tools");
	await pi.emit("turn_start", { turnIndex: 2 }, ctx);
	const blocked = await toolCall(pi, ctx);
	assert.equal(blocked?.block, true);
	assert.match(blocked.reason, /turn budget exhausted/);
	await pi.emit("turn_start", { turnIndex: 3 }, ctx);
	assert.equal(pi.sent.length, 1, "steer sent once");
});

test("child: token cap steers at 85% and blocks at 100%", async () => {
	const { pi, ctx } = await childSetup("scout", { maxTokens: 1000 });
	const usage = (input: number, cacheRead = 0) => ({ message: { role: "assistant", usage: { input, output: 0, cacheRead, cacheWrite: 0 }, stopReason: "toolUse" } });
	await pi.emit("message_end", usage(500), ctx);
	await pi.emit("message_end", { message: { role: "user" } }, ctx);
	assert.equal(pi.sent.length, 0);
	assert.equal(await toolCall(pi, ctx), undefined);
	await pi.emit("message_end", usage(300, 60), ctx);
	assert.equal(pi.sent.length, 1, "860 ≥ 850 steers");
	assert.equal((pi.sent[0].message as any).content, TOKEN_CAP_STEER);
	assert.equal(await toolCall(pi, ctx), undefined);
	await pi.emit("message_end", usage(200), ctx);
	const blocked = await toolCall(pi, ctx);
	assert.match(blocked?.reason ?? "", /token budget exhausted/);
	assert.ok(blocked.reason.endsWith(BUDGET_STOP));
});

test("child: a final message past 85% is not steered (the steer would start a turn over the report)", async () => {
	const { pi, ctx } = await childSetup("scout", { maxTokens: 1000 });
	const report = { role: "assistant", usage: { input: 900, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", content: [{ type: "text", text: "report" }] };
	await pi.emit("message_end", { message: report }, ctx);
	assert.equal(pi.sent.length, 0);
});

test("child: the role gate runs through tool_call with the owned files from the env", async () => {
	const { pi, ctx } = await childSetup("worker", {}, ["src/a.ts"]);
	assert.equal(await toolCall(pi, ctx, "edit", { path: "src/a.ts" }), undefined);
	assert.equal((await toolCall(pi, ctx, "edit", { path: "src/b.ts" }))?.block, true);
	assert.equal((await toolCall(pi, ctx, "bash", { command: "echo x > src/b.ts" }))?.block, true);
	assert.equal(await toolCall(pi, ctx, "bash", { command: "npm test" }), undefined);

	const git = await childSetup("git", {});
	assert.equal((await toolCall(git.pi, git.ctx, "bash", { command: "ls" }))?.block, true);
	assert.equal(await toolCall(git.pi, git.ctx, "bash", { command: "git log -1" }), undefined);
});

test("child: from the second gate block on, the reason says stop and report", async () => {
	const { pi, ctx } = await childSetup("test", {});
	const first = await toolCall(pi, ctx, "bash", { command: "ls" });
	assert.equal(first?.block, true);
	assert.ok(!first.reason.includes(GATE_STOP));
	assert.equal(await toolCall(pi, ctx, "bash", { command: "pwsh tests/run.ps1" }), undefined, "allowed calls do not count");
	const second = await toolCall(pi, ctx, "bash", { command: "cat x" });
	assert.ok(second.reason.endsWith(GATE_STOP));
});

test("main session: delegate and /subagents are registered, subagents.json is created", async () => {
	const dir = tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	kit.role = { isChild: false, role: undefined, depth: 0, maxTurns: undefined, maxTokens: undefined };
	await module.setup(pi as any, kit);
	const delegate = pi.tools.get("delegate");
	assert.ok(delegate);
	assert.ok(pi.commands.has("subagents"));
	assert.equal(delegate!.promptGuidelines?.length, 3);
	assert.match(delegate!.promptGuidelines![1], /disjoint areas/);
	assert.ok((delegate!.parameters as any).properties.background, "background flag exposed");
	const { existsSync } = await import("node:fs");
	assert.ok(existsSync(join(dir, "toolkit", "subagents.json")));

	const ctx = makeCtx();
	await assert.rejects(delegate!.execute("1", {}, undefined, undefined, ctx), /role \+ task/);
	await assert.rejects(delegate!.execute("1", { role: "worker", task: "x" }, undefined, undefined, ctx), /ownedFiles/);
	await assert.rejects(delegate!.execute("1", { role: "researcher", task: "x", model: "nope/x" }, undefined, undefined, ctx), /not available.*test\/test-model/);
	await assert.rejects(delegate!.execute("1", { tasks: [{ role: "nope", task: "x" }] }, undefined, undefined, ctx), /unknown role "nope"/);

	const call = delegate!.renderCall!({ role: "scout", task: "map the auth code\nmore" }, ctx.ui.theme, { args: {}, state: {}, invalidate() {}, lastComponent: undefined } as any).render(70);
	assert.match(call[0], /^╭─ DELEGATE ─+$/);
	assert.equal(call[1], "│ scout · map the auth code");
});
