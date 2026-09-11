import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, tempAgentDir } from "../../../test/harness.ts";
import module, { BASH_WINDOWS_NOTE, patchBash, patchGrep, regexProblem } from "../index.ts";

const RG_ERROR = "rg: regex parse error:\n    (?:ApiResponse(200)\n    ^\nerror: unclosed group";

function fakeGrep(calls: any[]) {
	return {
		name: "grep",
		description: "Search file contents",
		async execute(_id: string, params: any) {
			calls.push(params);
			if (!params.literal && params.pattern.includes("(")) throw new Error(RG_ERROR);
			return { content: [{ type: "text", text: "src/a.php:12: return new ApiResponse(200);" }], details: { matches: 1 } };
		},
	} as any;
}

test("grep: a pattern that is not a valid regex is searched again as a literal, with a note", async () => {
	const calls: any[] = [];
	const grep = patchGrep(fakeGrep(calls));
	const result = await grep.execute("1", { pattern: "ApiResponse(200", path: "src" }, undefined, undefined, {});
	assert.deepEqual(calls, [{ pattern: "ApiResponse(200", path: "src" }, { pattern: "ApiResponse(200", path: "src", literal: true }]);
	assert.equal(result.content[0].text, "[grep: not a valid regex (unclosed group); searched as a literal string]");
	assert.equal(result.content[1].text, "src/a.php:12: return new ApiResponse(200);");
	assert.deepEqual(result.details, { matches: 1 });
});

test("grep: other errors and literal searches are not retried", async () => {
	const calls: any[] = [];
	const failing = { ...fakeGrep(calls), execute: async (_id: string, params: any) => { calls.push(params); throw new Error(params.literal ? RG_ERROR : "Path not found: nope"); } } as any;
	await assert.rejects(patchGrep(failing).execute("1", { pattern: "x(", path: "nope" }, undefined, undefined, {}), /Path not found/);
	await assert.rejects(patchGrep(failing).execute("1", { pattern: "x(", literal: true }, undefined, undefined, {}), /regex parse error/);
	assert.equal(calls.length, 2, "one attempt each");
	assert.equal(regexProblem("boom"), "invalid regex");
});

test("bash: the Windows note is appended to the description", () => {
	const patched = patchBash({ name: "bash", description: "Execute a bash command." } as any);
	assert.equal(patched.description, `Execute a bash command. ${BASH_WINDOWS_NOTE}`);
});

test("setup patches grep everywhere and bash only on Windows", async () => {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	kit.flushToolPatches(pi as any);
	assert.ok(pi.tools.has("grep"));
	assert.equal(pi.tools.has("bash"), process.platform === "win32");
	if (process.platform === "win32") assert.ok(pi.tools.get("bash")!.description!.endsWith(BASH_WINDOWS_NOTE));
});
