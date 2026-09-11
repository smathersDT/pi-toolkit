import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRepo, gitAvailable, keyFor, knownRepos, normalizeRemote, resetRepoCache, resolveRepo, sanitizeLabel } from "../repo.ts";

test("every spelling of a remote normalizes to one label", () => {
	for (const url of [
		"git@github.com:Acme/Widgets.git",
		"https://github.com/acme/widgets",
		"https://user@github.com/acme/widgets.git/",
		"ssh://git@github.com/acme/widgets.git",
		"GitHub.com/Acme/Widgets",
	]) {
		assert.equal(normalizeRemote(url), "github.com/acme/widgets", url);
	}
	assert.equal(normalizeRemote("file:///C:/dev/repo.git"), "c:/dev/repo");
	assert.equal(normalizeRemote("C:\\dev\\repo"), "c:/dev/repo");
});

test("keys are the sanitized label plus an 8-char sha1", () => {
	const key = keyFor("github.com/acme/widgets");
	assert.match(key, /^github\.com__acme__widgets-[0-9a-f]{8}$/);
	assert.equal(keyFor("github.com/acme/widgets"), key);
	assert.notEqual(keyFor("github.com/acme/other"), key);
	assert.match(keyFor("c:/dev/my repo"), /^c__dev__my-repo-[0-9a-f]{8}$/);
	assert.equal(sanitizeLabel("///"), "repo");
});

test("resolution prefers the remote, then the common dir, then the path", (t) => {
	if (!gitAvailable()) {
		t.skip("git not installed");
		return;
	}
	resetRepoCache();
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	const tmp = (name: string) => mkdtempSync(join(tmpdir(), `pi-toolkit-repo-${name}-`));

	const withRemote = tmp("remote");
	git(withRemote, "init", "-q");
	git(withRemote, "remote", "add", "origin", "git@github.com:Acme/Widgets.git");
	const a = resolveRepo(withRemote);
	assert.equal(a.label, "github.com/acme/widgets");
	assert.equal(a.source, "remote");
	assert.equal(a.key, keyFor("github.com/acme/widgets"));
	const sub = join(withRemote, "sub");
	mkdirSync(sub);
	assert.equal(resolveRepo(sub).key, a.key, "a subdirectory keys to the same repo");

	const noRemote = tmp("local");
	git(noRemote, "init", "-q");
	const b = resolveRepo(noRemote);
	assert.equal(b.source, "common-dir");
	assert.equal(b.label, realpathSync.native(noRemote).replace(/\\/g, "/").toLowerCase());

	const plain = tmp("plain");
	const c = resolveRepo(plain);
	assert.equal(c.source, "path");
	assert.equal(c.label, realpathSync.native(plain).replace(/\\/g, "/").toLowerCase());
	assert.notEqual(c.key, b.key);

	assert.equal(findRepo(a.key), a);
	assert.equal(findRepo("https://github.com/Acme/Widgets.git"), a);
	assert.equal(findRepo("nope"), undefined);
	assert.equal(knownRepos().length, 3);
});

test("without git the path is the identity", () => {
	resetRepoCache();
	const r = resolveRepo("C:\\somewhere\\else", () => undefined);
	assert.equal(r.source, "path");
	assert.equal(r.label, "c:/somewhere/else");
	assert.equal(resolveRepo("C:\\somewhere\\else"), r, "cached per cwd");
});
