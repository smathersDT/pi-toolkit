import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeToon, needsQuotes, tryToon } from "../../../core/toon.ts";

test("objects: key: value lines, nested objects indent by two", () => {
	assert.equal(encodeToon({ a: 1, b: "x", c: { d: true, e: null } }), "a: 1\nb: x\nc:\n  d: true\n  e: null");
});

test("empty values: empty object is a bare key, empty array is []", () => {
	assert.equal(encodeToon({ a: {}, b: [] }), "a:\nb: []");
	assert.equal(encodeToon({}), "");
	assert.equal(encodeToon([]), "[]");
});

test("primitive arrays collapse to one line", () => {
	assert.equal(encodeToon({ tags: ["a", "b", "c"] }), "tags[3]: a,b,c");
	assert.equal(encodeToon([1, 2.5, true, null]), "[4]: 1,2.5,true,null");
});

test("uniform arrays of flat objects become a table", () => {
	const value = { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c d" }] };
	assert.equal(encodeToon(value), "items[3]{id,name}:\n  1,a\n  2,b\n  3,c d");
	// Root array, same shape.
	assert.equal(encodeToon([{ id: 1 }, { id: 2 }]), "[2]{id}:\n  1\n  2");
});

test("non-uniform arrays use list items with the first field on the hyphen", () => {
	const value = { rows: [{ a: 1 }, { b: 2, c: { d: 1 } }, 7, [1, 2], { nested: [{ x: 1 }, { x: 2 }] }] };
	assert.equal(
		encodeToon(value),
		["rows[5]:", "  - a: 1", "  - b: 2", "    c:", "      d: 1", "  - 7", "  - [2]: 1,2", "  - nested[2]{x}:", "      1", "      2"].join("\n"),
	);
});

test("quoting rules follow the spec", () => {
	for (const s of ["", " x", "x ", "true", "false", "null", "12", "-3.5", "1e5", "a:b", 'say "hi"', "a\\b", "a,b", "[x]", "{x}", "-dash", "#tag", "line\nbreak"]) {
		assert.equal(needsQuotes(s), true, `should quote ${JSON.stringify(s)}`);
	}
	for (const s of ["hello world", "x-y", "v1.2.3", "True", "a b c", "über", "50%"]) {
		assert.equal(needsQuotes(s), false, `should not quote ${JSON.stringify(s)}`);
	}
	assert.equal(encodeToon({ s: "" }), 's: ""');
	assert.equal(encodeToon({ s: "a,b" }), 's: "a,b"');
	assert.equal(encodeToon({ s: "line\nbreak" }), 's: "line\\nbreak"');
	// Keys: bare only for identifier-like names with dots; others quoted.
	assert.equal(encodeToon({ "my-key": 1, "a.b": 2, "with space": 3 }), '"my-key": 1\na.b: 2\n"with space": 3');
});

test("numbers are canonical", () => {
	assert.equal(encodeToon({ z: -0, f: 1.5, i: 10, big: 1e21 }), "z: 0\nf: 1.5\ni: 10\nbig: 1e+21");
});

test("tryToon converts whole-text JSON only when it saves 15%", () => {
	const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item-${i}`, active: i % 2 === 0, score: i * 1.5 }));
	const json = JSON.stringify(rows, null, 2);
	const r = tryToon(json);
	assert.ok(r, "tabular JSON must convert");
	assert.equal(r.whole, true);
	assert.ok(r.toon.startsWith("[20]{id,name,active,score}:"));
	assert.ok(r.saved >= Buffer.byteLength(json) * 0.15, `saved ${r.saved} of ${Buffer.byteLength(json)}`);
	// Round trip through the table: every value is still present.
	for (const row of rows) assert.ok(r.toon.includes(`${row.id},${row.name},${row.active},${row.score}`));

	// Minified nested JSON with unique keys saves only punctuation: refused.
	const dense = JSON.stringify({ a: { b: { c: "some text here" } }, d: "x,y", e: "k:v" });
	assert.equal(tryToon(dense), undefined);

	// Not JSON at all.
	assert.equal(tryToon("[compact: kept 3 of 9 lines]"), undefined);
	assert.equal(tryToon("plain prose"), undefined);
});

test("tryToon re-encodes fenced json blocks inside prose", () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, label: `row ${i}` }));
	const text = `Here is the data:\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\nThat is all.`;
	const r = tryToon(text);
	assert.ok(r);
	assert.equal(r.whole, false);
	assert.ok(r.toon.startsWith("Here is the data:\n```toon\n[12]{id,label}:\n"));
	assert.ok(r.toon.endsWith("\n```\nThat is all."));
	assert.ok(r.saved > 0);
});

test("tryToon honours minBytes", () => {
	const small = JSON.stringify([{ id: 1, n: "a" }, { id: 2, n: "b" }, { id: 3, n: "c" }], null, 2);
	assert.ok(tryToon(small), "converts without a floor");
	assert.equal(tryToon(small, { minBytes: 400 }), undefined);
});
