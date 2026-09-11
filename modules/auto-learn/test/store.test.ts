import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DAY_MS, forgetLesson, formatExpiry, lessonFile, loadLessons, normalizeText, related, saveLesson, similar, type StoreOptions, validateLesson, withLock } from "../store.ts";

const KEY = "github.com__acme__widgets-12345678";
const LABEL = "github.com/acme/widgets";
const origin = { provider: "test", model: "test-model", thinkingLevel: "medium", role: "main" };

function opts(over: Partial<StoreOptions> = {}): StoreOptions {
	return { dir: mkdtempSync(join(tmpdir(), "pi-toolkit-learn-store-")), ttlMs: 7 * DAY_MS, maxPerRepo: 20, maxLessonChars: 800, ...over };
}
const save = (o: StoreOptions, text: string, extra: Record<string, unknown> = {}) => saveLesson(o, KEY, { text, repoLabel: LABEL, origin, ...extra });
const readFile = (o: StoreOptions) => JSON.parse(readFileSync(lessonFile(o.dir, KEY), "utf8"));

test("add writes the documented file shape", async () => {
	const o = opts();
	const r = await save(o, "Run the suite with `npm test`; it needs Node 24.");
	assert.equal(r.status, "added");
	assert.equal(lessonFile(o.dir, KEY), join(o.dir, `${KEY}.json`));
	const raw = readFile(o);
	assert.deepEqual(Object.keys(raw), ["repo", "lessons"]);
	assert.equal(raw.repo, LABEL);
	assert.equal(raw.lessons.length, 1);
	const l = raw.lessons[0];
	assert.deepEqual(Object.keys(l).sort(), ["createdAt", "expiresAt", "id", "origin", "text"]);
	assert.match(l.id, /^[0-9a-f]{8}$/);
	assert.equal(Date.parse(l.expiresAt) - Date.parse(l.createdAt), 7 * DAY_MS);
	assert.deepEqual(l.origin, origin);
	assert.equal(existsSync(`${lessonFile(o.dir, KEY)}.lock`), false);
});

test("dedupe by normalized text keeps the original untouched", async () => {
	const o = opts({ now: () => 1_000_000 });
	const a = await save(o, "Use  pnpm, not npm, in this repo.");
	o.now = () => 2_000_000;
	const b = await save(o, "USE pnpm,   not npm, in this repo");
	assert.equal(b.status, "duplicate");
	assert.equal(b.lesson.id, a.lesson.id);
	assert.equal(b.lesson.createdAt, a.lesson.createdAt);
	assert.equal(b.lessons.length, 1);
	assert.equal(readFile(o).lessons[0].createdAt, new Date(1_000_000).toISOString());
	assert.equal(normalizeText("  Hello   World!! "), "hello world");
});

test("replace consolidates, keeps the earliest createdAt and stamps updatedAt", async () => {
	const o = opts({ now: () => 1_000_000 });
	await save(o, "dropdown.js needs a docReady stub in tests.");
	o.now = () => 5_000_000;
	await save(o, "form.js needs a docReady stub in tests.");
	o.now = () => 9_000_000;
	const r = await save(o, "dropdown.js and form.js need a docReady stub in tests.", {
		action: "replace",
		replaces: ["dropdown.js needs a docReady stub in tests.", "FORM.JS needs a docReady stub in tests"],
	});
	assert.equal(r.status, "replaced");
	assert.equal(r.removed.length, 2);
	assert.equal(r.lessons.length, 1);
	assert.equal(r.lesson.createdAt, new Date(1_000_000).toISOString());
	assert.equal(r.lesson.expiresAt, new Date(1_000_000 + 7 * DAY_MS).toISOString());
	assert.equal(r.lesson.updatedAt, new Date(9_000_000).toISOString());
	assert.equal(readFile(o).lessons.length, 1);
});

test("replace with a missing target fails and lists the current lessons", async () => {
	const o = opts();
	await save(o, "The build needs JAVA_HOME pointing at JDK 17.");
	await assert.rejects(
		save(o, "Something else entirely about the build.", { action: "replace", replaces: ["not a lesson"] }),
		/replaces not found: "not a lesson"\. Current lessons:\n1\. The build needs JAVA_HOME/,
	);
	await assert.rejects(save(o, "Something else entirely about the build.", { action: "replace" }), /needs replaces/);
	const { lessons } = loadLessons(o, KEY);
	assert.equal(lessons.length, 1);
	assert.equal(lessons[0].text, "The build needs JAVA_HOME pointing at JDK 17.");
});

test("replace refuses a target that shares no subject with the new lesson", async () => {
	const o = opts();
	await save(o, "The build needs JAVA_HOME pointing at the Zulu JDK 17 install.");
	await save(o, "The gradle wrapper refuses a blocked network path.");
	await assert.rejects(
		save(o, "Permission gate blocks writes under the java install directory.", { action: "replace", replaces: ["The build needs JAVA_HOME pointing at the Zulu JDK 17 install."] }),
		/shares no subject with the new lesson, so it would be deleted, not revised; nothing was saved/,
	);
	assert.equal(loadLessons(o, KEY).lessons.length, 2, "nothing removed");
	assert.equal(related("dropdown.js and form.js need a docReady stub.", "form.js needs a docReady stub in tests."), true);
	assert.equal(related("Use pwsh -c for PowerShell cmdlets.", "The build needs JAVA_HOME."), false);
});

test("the per-repo cap drops the oldest", async () => {
	let tick = 0;
	const o = opts({ now: () => 1_000_000 + tick * 1000 });
	for (let i = 0; i < 21; i++) {
		tick = i;
		const r = await save(o, `Lesson ${i}: widget${i} needs flag${i} set.`);
		assert.equal(r.dropped.length, i === 20 ? 1 : 0);
	}
	const { lessons } = loadLessons(o, KEY);
	assert.equal(lessons.length, 20);
	assert.equal(lessons[0].text, "Lesson 1: widget1 needs flag1 set.");
	assert.equal(lessons[19].text, "Lesson 20: widget20 needs flag20 set.");
});

test("expired lessons are swept on load and removed from the file", async () => {
	const o = opts();
	const file = lessonFile(o.dir, KEY);
	const now = Date.now();
	writeFileSync(
		file,
		JSON.stringify({
			repo: LABEL,
			lessons: [
				{ id: "aaaaaaaa", text: "old lesson that expired", createdAt: new Date(now - 8 * DAY_MS).toISOString(), expiresAt: new Date(now - DAY_MS).toISOString() },
				{ id: "bbbbbbbb", text: "fresh lesson still valid", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DAY_MS).toISOString() },
				{ id: "broken", text: "" },
			],
		}),
	);
	const r = loadLessons(o, KEY);
	assert.deepEqual(
		r.lessons.map((l) => l.id),
		["bbbbbbbb"],
	);
	assert.equal(r.expired.length, 1);
	assert.equal(readFile(o).lessons.length, 1);
	assert.equal(formatExpiry(new Date(now + DAY_MS + 3_600_000 * 2).toISOString(), now), "1d 2h");
	assert.equal(formatExpiry(new Date(now - 1).toISOString(), now), "expired");
});

test("two in-process writers serialise through the lock", async () => {
	const o = opts();
	const [a, b] = await Promise.all([save(o, "first concurrent lesson about paths"), save(o, "second concurrent lesson about flags")]);
	assert.equal(a.status, "added");
	assert.equal(b.status, "added");
	assert.equal(loadLessons(o, KEY).lessons.length, 2);
	assert.equal(existsSync(`${lessonFile(o.dir, KEY)}.lock`), false);
});

test("a fresh foreign lock blocks; a stale one is taken over", async () => {
	const o = opts();
	const file = lessonFile(o.dir, KEY);
	const lock = `${file}.lock`;
	writeFileSync(lock, "999999");
	await assert.rejects(withLock(file, () => 1, 3, 10), /lesson store busy/);
	assert.ok(existsSync(lock));
	const old = (Date.now() - 20_000) / 1000;
	utimesSync(lock, old, old);
	assert.equal(await withLock(file, () => 42), 42);
	assert.equal(existsSync(lock), false);
});

test("placeholders and oversize lessons are rejected without writing", async () => {
	const o = opts({ maxLessonChars: 50 });
	for (const bad of ["n/a", "none", "todo", "short one", "N/A.", "   "]) await assert.rejects(save(o, bad), /placeholder/);
	await assert.rejects(save(o, "x".repeat(51)), /max 50/);
	assert.equal(validateLesson("A perfectly fine lesson.", 800), undefined);
	assert.equal(existsSync(lessonFile(o.dir, KEY)), false);
});

test("forget removes one lesson by index", async () => {
	const o = opts();
	await save(o, "First lesson to keep around.");
	await save(o, "Second lesson to forget later.");
	const r = await forgetLesson(o, KEY, 1);
	assert.equal(r.removed?.text, "Second lesson to forget later.");
	assert.equal(r.lessons.length, 1);
	assert.equal((await forgetLesson(o, KEY, 5)).removed, undefined);
	assert.equal(readFile(o).lessons.length, 1);
});

test("an add that nearly repeats an existing lesson is refused as similar, not written", async () => {
	const o = opts();
	const first = "When searching PHP attribute text containing parentheses with grep, set literal:true unless a regular expression is required.";
	const near = "When searching PHP named-argument or bracket text with grep, use literal:true to avoid malformed regular expressions.";
	const a = await save(o, first);
	const b = await save(o, near);
	assert.equal(b.status, "similar");
	assert.equal(b.lesson.id, a.lesson.id, "the existing lesson comes back so the caller can replace it");
	assert.equal(readFile(o).lessons.length, 1);
	assert.equal((await save(o, near, { action: "replace", replaces: [first] })).status, "replaced");

	assert.equal(similar("Repository application classes are rooted under src/, so read the API Ninjas integration at src/integration/api_ninjas/ApiNinjas.php.", "Repository API classes are rooted under src/, so read GeneralApi at src/api/general/GeneralApi.php."), true);
	assert.equal(similar("Tests run with pwsh tests/run.ps1, not phpunit.", "functions.bash parses the command with Bash even when invoking pwsh, so chain PowerShell script invocations with Bash operators."), false);
	assert.equal(similar("first concurrent lesson about paths", "second concurrent lesson about flags"), false, "three shared words are not enough");
	assert.equal(similar("", "anything at all here"), false);
});
