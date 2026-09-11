import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { callPaths, gitRootOf, resetRootCache } from "../detect.ts";

const cwd = resolve("/work/app");

test("path tools name their path, resolved against cwd", () => {
	assert.deepEqual(callPaths("read", { path: "src/a.ts" }, cwd), [join(cwd, "src", "a.ts")]);
	assert.deepEqual(callPaths("grep", { pattern: "x", path: "@lib" }, cwd), [join(cwd, "lib")]);
	assert.deepEqual(callPaths("learn", { path: "x" }, cwd), [], "other tools name nothing");
	assert.deepEqual(callPaths("read", {}, cwd), []);
});

test("bash names cd targets and absolute paths", () => {
	assert.deepEqual(callPaths("bash", { command: "cd ../other && npm test" }, cwd, "linux"), [resolve(cwd, "../other")]);
	assert.deepEqual(callPaths("bash", { command: 'ls "/srv/data/x" ~/notes.md' }, cwd, "linux"), [resolve("/srv/data/x"), join(homedir(), "notes.md")]);
	assert.deepEqual(callPaths("bash", { command: "echo hi" }, cwd, "linux"), []);
	const win = callPaths("bash", { command: "cat C:\\dev\\front\\a.js /c/dev/back/b.php && cd 'C:/dev/x y'" }, "C:\\dev\\back", "win32");
	assert.equal(win.length, 3);
	assert.ok(win.some((p) => /front[\\/]a\.js$/.test(p)));
	assert.ok(win.some((p) => /^C:[\\/]dev[\\/]back[\\/]b\.php$/i.test(p)), "Git Bash /c/ paths become C:/");
	assert.ok(win.some((p) => /x y$/.test(p)), "quoted cd target");
	assert.equal(callPaths("bash", { command: Array.from({ length: 20 }, (_, i) => `cat /p${i}/x`).join("; ") }, cwd, "linux").length, 8, "capped");
});

test("gitRootOf walks up to the nearest .git and caches every directory it passed", () => {
	resetRootCache();
	const repo = resolve("/work/app");
	const seen: string[] = [];
	const exists = (p: string) => {
		seen.push(p);
		return p === join(repo, ".git");
	};
	assert.equal(gitRootOf(join(repo, "src", "deep", "a.ts"), exists), repo);
	const probes = seen.length;
	assert.equal(gitRootOf(join(repo, "src", "deep"), exists), repo);
	assert.equal(seen.length, probes, "cached");
	assert.equal(gitRootOf(resolve("/elsewhere/x"), () => false), undefined);
});
