import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, describeCall, expectedExit, type Failure, finalCommand, guidance } from "../policy.ts";

function bash(command: string, text: string, isError = true, details?: unknown) {
	return { toolName: "bash", toolCallId: "c", input: { command }, content: [{ type: "text", text }], isError, details };
}
const exit = (code: number, out = "") => `${out}${out ? "\n\n" : ""}Command exited with code ${code}`;

test("grep exit 1 is a finding, not a failure", () => {
	assert.equal(classify(bash("grep foo src/", exit(1))), undefined);
	assert.equal(classify(bash('rg -n "a|b" src', exit(1))), undefined);
	assert.equal(classify(bash("cd x && rtk grep foo .", exit(1))), undefined);
	assert.equal(classify(bash("egrep -c foo a.txt", exit(1, "0"))), undefined);
	assert.equal(classify(bash("diff a.txt b.txt", exit(1, "1c1\n< a\n> b"))), undefined);
	assert.equal(classify(bash("cmp a b", exit(1, "a b differ: byte 1"))), undefined);
	assert.equal(classify(bash("[ -f missing ]", exit(1))), undefined);
	assert.equal(classify(bash("test -d out", exit(1))), undefined);
	assert.equal(classify(bash("which foo | head -1", exit(1))), undefined);
	assert.equal(classify(bash("which foo", exit(1, "which: no foo in (/usr/bin)"))), "error");
	assert.equal(classify(bash("grep foo nope.txt", exit(2, "grep: nope.txt: No such file or directory"))), "error");
	assert.equal(classify(bash("grep foo x | sort | uniq -c | sort -rn | head -5", exit(0, "3 foo"), false)), undefined);
});

test("bash details.exitCode is honoured", () => {
	assert.equal(classify(bash("diff a b", "1c1", false, { exitCode: 1 })), undefined);
	assert.equal(classify(bash("make", "error", false, { exitCode: 2 })), "error");
	assert.equal(classify(bash("ls", "a\nb", false, { exitCode: 0 })), undefined);
});

test("ENOENT and friends are failures, except a file tool given a wrong path", () => {
	const read = (text: string, isError: boolean) => ({ toolName: "read", toolCallId: "r", input: { path: "x" }, content: [{ type: "text", text }], isError });
	assert.equal(classify(read("ENOENT: no such file or directory, open 'x'", true)), undefined);
	assert.equal(classify(read("File not found: x", false)), undefined);
	assert.equal(classify({ toolName: "grep", toolCallId: "g", input: { path: "nope" }, content: [{ type: "text", text: "Path not found: C:\dev\nope" }], isError: true }), undefined);
	assert.equal(classify(read("EACCES: permission denied, open 'x'", true)), "error", "other read errors still count");
	assert.equal(classify(bash("cat missing.txt", exit(1, "cat: missing.txt: No such file or directory"))), "error", "bash can be a missing tool or env");
	assert.equal(classify(bash("foo --bar", exit(127, "bash: foo: command not found"))), "error");
	assert.equal(classify(bash("dir", "'dir' is not recognized as an internal or external command", false)), "error");
	assert.equal(classify({ toolName: "edit", toolCallId: "e", input: { path: "a.ts" }, content: [{ type: "text", text: "Could not edit file: a.ts. oldText not found in file." }], isError: true }), "error");
	assert.equal(classify(bash("cat /root/x", exit(1, "cat: /root/x: Permission denied"))), "error");
});

test("successful output that merely mentions an error phrase is not a failure", () => {
	const listing = "src/a.ts: Permission denied is handled here\n".repeat(30);
	assert.equal(classify(bash("grep -rn denied src", listing, false)), undefined);
	assert.equal(classify(bash("ls", "a\nb", false)), undefined);
	assert.equal(classify({ toolName: "read", toolCallId: "r", input: { path: "x" }, content: [{ type: "text", text: `${"const x = 1;\n".repeat(60)}// ENOENT handling` }], isError: false }), undefined);
});

test("keepalive, transient and our own results are ignored", () => {
	assert.equal(classify(bash("sleep 100", "still running", true, { keepalive: { running: true } })), undefined);
	assert.equal(classify(bash("npm test", "Command timed out after 120 seconds")), undefined);
	assert.equal(classify(bash("npm test", "[killed: timeout]\n\nCommand exited with code 137")), undefined);
	assert.equal(classify({ toolName: "learn", toolCallId: "l", input: {}, content: [{ type: "text", text: "Unknown failureId" }], isError: true }), undefined);
});

test("permission refusals are their own kind", () => {
	assert.equal(classify(bash("rm -rf /", "[permissions] blocked by permissions: rm -rf / (rule: no-rm-root)")), "refusal");
	assert.equal(classify({ toolName: "write", toolCallId: "w", input: { path: ".env" }, content: [{ type: "text", text: "Write to .env blocked by permissions" }], isError: true }), "refusal");
	assert.equal(classify(bash("cat notes.md", "the [permissions] module blocks rm", false)), undefined);
});

test("finalCommand strips wrappers and respects quotes", () => {
	assert.deepEqual(finalCommand('FOO=1 rtk proxy grep -E "a|b" x'), { name: "grep", chained: false });
	assert.deepEqual(finalCommand("cd a && /usr/bin/diff x y"), { name: "diff", chained: true });
	assert.deepEqual(finalCommand("timeout 30 rg foo; echo done"), { name: "echo", chained: true });
	assert.deepEqual(finalCommand("git status --porcelain 2>&1"), { name: "git", chained: false });
	assert.equal(finalCommand("   "), undefined);
	assert.equal(expectedExit("grep x y", 2), false);
	assert.equal(expectedExit("grep x y", 1), true);
});

test("describeCall picks the interesting argument and clips", () => {
	assert.equal(describeCall("bash", { command: "ls   -la" }), "ls -la");
	assert.equal(describeCall("read", { path: "a.ts", offset: 1 }), "a.ts");
	assert.equal(describeCall("bash", { command: "x".repeat(500) }).length, 200);
	assert.equal(describeCall("thing", { n: 1 }), '{"n":1}');
});

test("guidance is short and names the id", () => {
	const base: Failure = { id: "L3", kind: "error", toolName: "bash", toolCallId: "c", head: "x", error: "y", repoKey: "k", handled: false };
	for (const kind of ["error", "refusal"] as const) {
		const text = guidance({ ...base, kind });
		assert.ok(text.startsWith("[auto-learn L3] "), text);
		assert.ok(text.includes('learn({failureId:"L3", lesson:"…"})'), text);
		assert.ok(text.split(/\s+/).length < 60, `${text.split(/\s+/).length} words`);
		assert.equal(text.includes("\n"), false);
	}
	assert.match(guidance(base), /^\[auto-learn L3\] Once you have a verified fix .* save the cause and what to do next time — tool usage, command syntax/);
	assert.equal(guidance(base).includes("about this repo"), false, "any verified correction counts, not only repo facts");
	assert.match(guidance(base), /test setup; not where code lives/, "layout facts are not lessons");
	assert.match(guidance({ ...base, kind: "refusal" }), /do not retry it or route around it/);
});
