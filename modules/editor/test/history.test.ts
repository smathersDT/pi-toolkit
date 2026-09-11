import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeJsonAtomic } from "../../../core/paths.ts";
import { tempAgentDir } from "../../../test/harness.ts";
import { historyFile, isSlashCommand, loadHistory, MAX_ENTRIES, persistEntry } from "../history.ts";

test("historyFile lives under <agent-dir>/toolkit", () => {
	const dir = tempAgentDir();
	assert.equal(historyFile(dir), join(dir, "toolkit", "history.json"));
});

test("isSlashCommand covers commands with arguments, not prompts mentioning them", () => {
	assert.equal(isSlashCommand("/clear"), true);
	assert.equal(isSlashCommand("  /costs report 2d"), true);
	assert.equal(isSlashCommand("explain /costs report 2d"), false);
});

test("loadHistory filters junk and commands, keeps order, caps at MAX_ENTRIES", () => {
	const file = historyFile(tempAgentDir());
	assert.deepEqual(loadHistory(file), [], "missing file");
	writeJsonAtomic(file, ["/costs report 2d", "remember me", " /loop 5m /foo", "/clear", "explain /costs report 2d", 42, "", "  "]);
	assert.deepEqual(loadHistory(file), ["remember me", "explain /costs report 2d"]);
	writeFileSync(file, "{ not json");
	assert.deepEqual(loadHistory(file), []);
	writeJsonAtomic(file, { nope: true });
	assert.deepEqual(loadHistory(file), []);
	writeJsonAtomic(file, Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => `p${i}`));
	assert.equal(loadHistory(file).length, MAX_ENTRIES);
});

test("persistEntry merges newest-first, deduplicates, skips commands, caps", () => {
	const file = historyFile(tempAgentDir());
	persistEntry(file, "first");
	persistEntry(file, "second");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["second", "first"]);
	persistEntry(file, "first");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["first", "second"], "an old entry is promoted, not duplicated");
	persistEntry(file, "/model x");
	persistEntry(file, "   ");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["first", "second"]);
	for (let i = 0; i < MAX_ENTRIES + 5; i++) persistEntry(file, `p${i}`);
	const stored = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(stored.length, MAX_ENTRIES);
	assert.equal(stored[0], `p${MAX_ENTRIES + 4}`);
	assert.ok(!existsSync(`${file}.tmp`));
});

test("a commands-only file is cleaned by the next write", () => {
	const file = historyFile(tempAgentDir());
	writeJsonAtomic(file, ["/clear", "keep", "/new"]);
	persistEntry(file, "fresh");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["fresh", "keep"]);
});
