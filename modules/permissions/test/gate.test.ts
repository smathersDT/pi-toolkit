import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import { createToolkit } from "../../../core/kit.ts";
import module from "../index.ts";

const CWD = "/home/u/proj";

interface Harness {
	pi: FakePi;
	dir: string;
	file: string;
	rules(): any;
	call(input: Record<string, unknown>, ctx?: any, toolName?: string): Promise<any>;
}

async function setup(options: { child?: boolean } = {}): Promise<Harness> {
	const dir = tempAgentDir();
	if (options.child) process.env.PI_TOOLKIT_DEPTH = "1";
	else delete process.env.PI_TOOLKIT_DEPTH;
	try {
		const pi = new FakePi();
		const kit = createToolkit(pi as any, { modules: {} });
		await module.setup(pi as any, kit);
		const file = join(dir, "toolkit", "permissions.json");
		return {
			pi,
			dir,
			file,
			rules: () => JSON.parse(readFileSync(file, "utf8")),
			call: async (input, ctx = makeCtx({ cwd: CWD }), toolName = "bash") => {
				const [result] = await pi.emit("tool_call", { toolName, toolCallId: "1", input }, ctx);
				return result;
			},
		};
	} finally {
		delete process.env.PI_TOOLKIT_DEPTH;
	}
}

/** A select() that records its calls and answers from a script. */
function selector(answers: Array<string | undefined>) {
	const calls: Array<{ title: string; options: string[] }> = [];
	const select = async (title: string, options: string[]) => {
		calls.push({ title, options });
		return answers.shift();
	};
	return { calls, select };
}

test("creates permissions.json with defaults on first run", async () => {
	const h = await setup();
	assert.ok(existsSync(h.file));
	assert.deepEqual(h.rules(), { mode: "block", workspaces: [], allow: [], deny: [], askOnce: true });
	assert.ok(h.pi.commands.has("permissions"));
});

test("a block-tier call is refused with a [permissions] reason and no dialog", async () => {
	const h = await setup();
	const { calls, select } = selector([]);
	const result = await h.call({ command: "rm -rf /" }, makeCtx({ cwd: CWD, select }));
	assert.equal(result.block, true);
	assert.match(result.reason, /^\[permissions\] refused: rm on \/ \(the filesystem root\)/);
	assert.match(result.reason, /Do not retry/);
	assert.equal(calls.length, 0);
});

test("a silent call returns undefined without a dialog", async () => {
	const h = await setup();
	const { calls, select } = selector([]);
	assert.equal(await h.call({ command: "npm test" }, makeCtx({ cwd: CWD, select })), undefined);
	assert.equal(await h.call({ path: "src/a.ts", content: "" }, makeCtx({ cwd: CWD, select }), "write"), undefined);
	assert.equal(calls.length, 0);
});

test("confirm tier: the dialog shows the command; Allow once passes and is cached (askOnce)", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: true, note: "dialog test" }));
	const { calls, select } = selector(["Allow once"]);
	const ctx = makeCtx({ cwd: CWD, select });
	assert.equal(await h.call({ command: "git reset --hard" }, ctx), undefined);
	assert.equal(calls.length, 1);
	assert.match(calls[0].title, /git reset --hard/);
	assert.deepEqual(calls[0].options, ["Allow once", "Allow always (save rule)", "Deny"]);
	// identical command: not asked again
	assert.equal(await h.call({ command: "git reset --hard" }, ctx), undefined);
	assert.equal(calls.length, 1);
	// a different command is asked (and, with no answer left, refused)
	const result = await h.call({ command: "git clean -fd" }, ctx);
	assert.equal(calls.length, 2);
	assert.equal(result.block, true);
	assert.deepEqual(h.rules().allow, [], "Allow once saves nothing");
});

test("askOnce false asks every time", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: false }));
	const { calls, select } = selector(["Allow once", "Allow once"]);
	const ctx = makeCtx({ cwd: CWD, select });
	await h.call({ command: "git reset --hard" }, ctx);
	await h.call({ command: "git reset --hard" }, ctx);
	assert.equal(calls.length, 2);
});

test("Allow always writes a Bash(<first two words>:*) rule that covers later variants", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: true, note: "dialog test" }));
	const { calls, select } = selector(["Allow always (save rule)"]);
	const ctx = makeCtx({ cwd: CWD, select });
	assert.equal(await h.call({ command: "git reset --hard" }, ctx), undefined);
	assert.deepEqual(h.rules().allow, ["Bash(git reset:*)"]);
	assert.ok(ctx.ui.notifications.some((n: any) => /saved allow rule Bash\(git reset:\*\)/.test(n.message)));
	// a different git reset is now allowed by the rule, without a dialog
	assert.equal(await h.call({ command: "git reset --hard HEAD~1" }, ctx), undefined);
	assert.equal(calls.length, 1);
});

test("Allow always on a write saves Write(<dir>/**)", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: true, note: "dialog test" }));
	const { calls, select } = selector(["Allow always (save rule)"]);
	const ctx = makeCtx({ cwd: CWD, select });
	assert.equal(await h.call({ path: "/home/u/other/notes.md", content: "" }, ctx, "write"), undefined);
	assert.deepEqual(h.rules().allow, ["Write(/home/u/other/**)"]);
	assert.equal(await h.call({ path: "/home/u/other/deeper/x.md", oldText: "", newText: "" }, ctx, "edit"), undefined);
	assert.equal(calls.length, 1);
});

test("Deny blocks with the user-denial reason; Esc (undefined) counts as deny", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: true, note: "dialog test" }));
	const { select } = selector(["Deny", undefined]);
	const ctx = makeCtx({ cwd: CWD, select });
	const denied = await h.call({ command: "git reset --hard" }, ctx);
	assert.equal(denied.block, true);
	assert.ok(denied.reason.startsWith("[permissions] denied by user"), denied.reason);
	const escaped = await h.call({ command: "git clean -fd" }, ctx);
	assert.equal(escaped.block, true);
	assert.ok(escaped.reason.startsWith("[permissions] denied by user"));
});

test("no UI (print mode): a confirm-tier call is refused and the reason names the mode", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: true, note: "dialog test" }));
	const { calls, select } = selector(["Allow once"]);
	const result = await h.call({ command: "git reset --hard" }, makeCtx({ cwd: CWD, mode: "print", select }));
	assert.equal(result.block, true);
	assert.match(result.reason, /^\[permissions\] refused: .*no UI \(guard mode\)/);
	assert.equal(calls.length, 0);
});

test("child process: a confirm-tier call is refused, no /permissions command", async () => {
	const h = await setup({ child: true });
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: [], allow: [], deny: [], askOnce: true, note: "dialog test" }));
	const { calls, select } = selector(["Allow once"]);
	const result = await h.call({ command: "git reset --hard" }, makeCtx({ cwd: CWD, select }));
	assert.equal(result.block, true);
	assert.match(result.reason, /child process has no dialog \(guard mode\)/);
	assert.equal(calls.length, 0);
	assert.ok(!h.pi.commands.has("permissions"));
	assert.equal(await h.call({ command: "npm test" }), undefined);
});

test("the rules file is re-read when it changes on disk", async () => {
	const h = await setup();
	const { calls, select } = selector(["Allow once"]);
	writeFileSync(h.file, JSON.stringify({ mode: "strict", workspaces: [], allow: [], deny: [], askOnce: true }));
	const result = await h.call({ command: "git reset --hard" }, makeCtx({ cwd: CWD, select }));
	assert.equal(result.block, true);
	assert.match(result.reason, /strict mode never asks/);
	assert.equal(calls.length, 0);
	writeFileSync(h.file, JSON.stringify({ mode: "yolo", workspaces: [], allow: [], deny: [], askOnce: true }));
	assert.equal(await h.call({ command: "rm -rf /" }), undefined);
});

test("deny rules from the file win over everything, including yolo", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "yolo", workspaces: [], allow: ["Bash(git push:*)"], deny: ["Bash(git push:*)"], askOnce: true }));
	const result = await h.call({ command: "git push origin feature" });
	assert.equal(result.block, true);
	assert.match(result.reason, /deny rule "Bash\(git push:\*\)"/);
});

test("configured workspaces make writes there silent", async () => {
	const h = await setup();
	writeFileSync(h.file, JSON.stringify({ mode: "guard", workspaces: ["/home/u/other"], allow: [], deny: [], askOnce: true }));
	const { calls, select } = selector([]);
	assert.equal(await h.call({ path: "/home/u/other/x.md", content: "" }, makeCtx({ cwd: CWD, select }), "write"), undefined);
	assert.equal(calls.length, 0);
});

test("/permissions: show, mode, add, allow, deny", async () => {
	const h = await setup();
	const cmd = h.pi.commands.get("permissions")!;
	const ctx = makeCtx({ cwd: CWD });

	await cmd.handler("", ctx);
	const frame = h.pi.entries.find((e) => e.customType === "toolkit-frame") as any;
	assert.ok(frame, "show prints a frame");
	assert.equal(frame.data.title, "permissions");
	assert.match(frame.data.head[0], /mode block · 0 workspaces · 0 allow · 0 deny/);
	assert.ok(frame.data.lines.some((l: string) => l.includes(h.file)));

	await cmd.handler("mode strict", ctx);
	assert.equal(h.rules().mode, "strict");
	await cmd.handler("mode bogus", ctx);
	assert.equal(h.rules().mode, "strict");
	assert.ok(ctx.ui.notifications.some((n: any) => n.type === "error"));

	await cmd.handler("add ../other", ctx);
	assert.deepEqual(h.rules().workspaces.map((w: string) => w.replace(/\\/g, "/")), ["/home/u/other"]);
	await cmd.handler("add /home/u/other", ctx);
	assert.equal(h.rules().workspaces.length, 1, "deduplicated");

	await cmd.handler("allow Bash(npm run:*)", ctx);
	await cmd.handler("deny re:^rm -rf", ctx);
	assert.deepEqual(h.rules().allow, ["Bash(npm run:*)"]);
	assert.deepEqual(h.rules().deny, ["re:^rm -rf"]);

	assert.deepEqual(
		cmd.getArgumentCompletions?.("mode s"),
		[{ value: "mode strict", label: "mode strict" }],
	);
});

test("logDecisions notifies non-silent decisions", async () => {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {}, permissions: { logDecisions: true } });
	await module.setup(pi as any, kit);
	const ctx = makeCtx({ cwd: CWD });
	await pi.emit("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "rm -rf /" } }, ctx);
	await pi.emit("tool_call", { toolName: "bash", toolCallId: "2", input: { command: "npm test" } }, ctx);
	assert.equal(ctx.ui.notifications.length, 1);
	assert.match(ctx.ui.notifications[0].message, /^\[permissions\] \[permissions\] refused/);
});
