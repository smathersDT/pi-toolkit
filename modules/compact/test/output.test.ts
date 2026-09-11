import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";
import { compactOutput, DEFAULT_CAPS, foldSimilarLines, isLogPath, maskTokens, policyFor, type CompactRequest } from "../output.ts";

const tr = { head: truncateHead, tail: truncateTail };
const cfg = { caps: DEFAULT_CAPS, toon: true, maskLogs: true };

function run(toolName: string, text: string, extra: Partial<CompactRequest> = {}, spillDir = join(tempAgentDir(), "spill")) {
	return compactOutput({ toolName, toolCallId: "call-1", input: {}, text, isError: false, ...extra }, cfg, tr, spillDir);
}

/** The test's own decoder: rebuild the original from body + legend. */
function unmaskWith(body: string, legend: string): string {
	const map = new Map<string, string>();
	for (const entry of legend.slice("[legend: ".length, -1).split(" ")) {
		const eq = entry.indexOf("=");
		map.set(entry.slice(0, eq), entry.slice(eq + 1));
	}
	return body.replace(/§\d+/g, (m) => map.get(m) ?? m);
}

test("hygiene: ANSI stripped, carriage returns replayed, trailing whitespace dropped", () => {
	const text = "\u001b[32mok\u001b[0m   \nprogress 10%\rprogress 55%\rprogress 100%\n\n\n\ndone\n";
	const r = run("bash", text);
	assert.equal(r.text, "ok\nprogress 100%\n\ndone");
	assert.ok(r.after < r.before);
});

test("identical lines fold to one line plus a count", () => {
	const r = run("bash", ["start", ...Array(6).fill("warning: deprecated"), "end"].join("\n"));
	assert.equal(r.text, "start\nwarning: deprecated\n[+5 identical lines]\nend");
});

test("similar-line folding keeps the first and last line of a run", () => {
	const lines = Array.from({ length: 8 }, (_, i) => `2024-05-01T10:00:${String(i).padStart(2, "0")}Z INFO worker req=${1000 + i} took ${i * 3}ms`);
	const folded = foldSimilarLines(lines.join("\n"));
	assert.equal(folded, `${lines[0]}\n[+6 similar lines]\n${lines[7]}`);
	// Runs under five lines stay verbatim.
	assert.equal(foldSimilarLines(lines.slice(0, 4).join("\n")), lines.slice(0, 4).join("\n"));
	// Applied to bash and log reads, not to source reads.
	assert.ok(run("bash", lines.join("\n")).text.includes("[+6 similar lines]"));
	assert.ok(run("read", lines.join("\n"), { input: { path: "/var/log/app.log" } }).text.includes("[+6 similar lines]"));
	assert.ok(!run("read", lines.join("\n"), { input: { path: "/src/app.ts" } }).text.includes("similar lines"));
});

test("isLogPath recognises log files and log directories", () => {
	for (const p of ["/var/log/syslog", "app.log", "app.log.1", "build.out", "err.trace", "C:\\proj\\logs\\x.txt", "logs/today.txt"]) assert.equal(isLogPath(p), true, p);
	for (const p of ["/src/index.ts", "README.md", "catalog.json", "/home/u/blog/post.md"]) assert.equal(isLogPath(p), false, p);
});

test("legend masking is lossless: unmask rebuilds the original", () => {
	const path = "/home/mathe/projects/dialtower-back/storage/logs/laravel.log";
	const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
	const cls = "com.example.billing.InvoiceService";
	const lines: string[] = [];
	for (let i = 0; i < 6; i++) lines.push(`${cls} handled ${uuid} from ${path} in ${i}ms`);
	lines.push("§ must not appear", "tail line");
	const original = lines.join("\n").replace("§ must not appear", "plain line");
	const masked = maskTokens(original);
	assert.ok(masked, "three repeated tokens must mask");
	assert.ok(masked.legend.startsWith("[legend: §1=") && masked.legend.endsWith("]"));
	assert.ok(masked.text.includes("§1"));
	assert.ok(!masked.text.includes(path));
	assert.equal(unmaskWith(masked.text, masked.legend), original);
	assert.ok(Buffer.byteLength(masked.text) + Buffer.byteLength(masked.legend) < Buffer.byteLength(original) * 0.88);
	// Text that already uses § is left alone, so the round trip can never be ambiguous.
	assert.equal(maskTokens(`${original}\n§`), undefined);
	// Two occurrences are not enough.
	assert.equal(maskTokens(lines.slice(0, 2).join("\n")), undefined);
});

test("masking applies to bash, log reads and delegate results, with the legend on the kept side", () => {
	const path = "/opt/services/gateway/current/releases/2024-05-01/app";
	const verbs = ["loaded", "linked", "verified", "cached", "mapped", "closed"];
	// Different verbs so the similar-line fold (which runs first) leaves all six lines.
	const body = verbs.map((v, i) => `${v} ${path}/module-${i}.so`).join("\n");
	const bash = run("bash", body);
	// The shared directory prefix is the token: six different files, one legend entry.
	assert.ok(bash.text.endsWith(`\n[legend: §1=${path}/]`), bash.text);
	assert.ok(bash.text.startsWith("loaded §1module-0.so\n"), bash.text);
	assert.equal(unmaskWith(bash.text.split("\n").slice(0, -1).join("\n"), bash.text.split("\n").at(-1)!), body);
	const delegate = run("delegate", body);
	assert.ok(delegate.text.startsWith("[legend: "), "head-kept results carry the legend on top");
	const source = run("read", body, { input: { path: "/src/loader.ts" } });
	assert.equal(source.text, body, "source reads are never masked");
	const grep = run("grep", body);
	assert.equal(grep.text, body);
});

test("JSON output becomes TOON for bash but never for read", () => {
	const rows = Array.from({ length: 15 }, (_, i) => ({ id: i, name: `n${i}`, ok: true }));
	const json = JSON.stringify(rows, null, 2);
	const bash = run("bash", json);
	assert.ok(bash.text.startsWith("[toon]\n[15]{id,name,ok}:"), bash.text.slice(0, 60));
	const read = run("read", json, { input: { path: "/data/rows.json" } });
	assert.ok(!read.text.includes("[toon]"));
	const off = compactOutput({ toolName: "bash", toolCallId: "c", input: {}, text: json, isError: false }, { ...cfg, toon: false }, tr, join(tempAgentDir(), "spill"));
	assert.ok(!off.text.includes("[toon]"));
});

test("bash output is capped from the tail with the marker at the bottom and a spill file", () => {
	const spillDir = join(tempAgentDir(), "spill");
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
	// Neighbouring lines differ in a word, so the similar-line fold leaves them alone.
	const lines = Array.from({ length: 600 }, (_, i) => `line ${i} ${words[i % 7]} ${"x".repeat(20)} ${i * 7919}`);
	const r = run("bash", lines.join("\n"), { toolCallId: "toolu_01AB" }, spillDir);
	const out = r.text.split("\n");
	const marker = out[out.length - 1];
	assert.match(marker, /^\[compact: kept \d+ of 600 lines, [\d.]+KB -> [\d.]+KB; full output: .*toolu_01AB\.txt\]$/);
	assert.ok(r.text.includes(lines[599]), "last line kept");
	assert.ok(!r.text.includes("line 0 "), "first line cut");
	assert.ok(Buffer.byteLength(r.text) <= DEFAULT_CAPS.bash + marker.length + 2);
	assert.ok(r.spillPath && existsSync(r.spillPath));
	assert.equal(readFileSync(r.spillPath, "utf8"), lines.join("\n"));
});

test("read output is capped from the head with an offset note that counts file lines", () => {
	const lines = Array.from({ length: 3000 }, (_, i) => `${i + 1}: ${"y".repeat(30)}`);
	const r = run("read", lines.join("\n"), { input: { path: "/big/file.txt" } });
	const first = r.text.split("\n")[0];
	const m = first.match(/^\[compact: kept (\d+) of 3000 lines, [\d.]+KB -> [\d.]+KB; read \/big\/file\.txt with offset=(\d+) for the rest\]$/);
	assert.ok(m, first);
	assert.equal(Number(m[2]), Number(m[1]) + 1);
	assert.ok(r.text.includes("\n1: yyy"));
	assert.ok(!r.text.includes("3000: "));
	assert.equal(r.spillPath, undefined);
	// A read that started at an offset continues from there.
	const r2 = run("read", lines.join("\n"), { input: { path: "/big/file.txt", offset: 50 } });
	const m2 = r2.text.split("\n")[0].match(/offset=(\d+) for the rest/);
	assert.ok(m2);
	assert.equal(Number(m2[1]), 50 + Number(m[1]));
});

test("a first line over the cap is cut on a UTF-8 boundary and spills, never an offset=1 loop", () => {
	const spillDir = join(tempAgentDir(), "spill");
	const minified = `var a=${"é".repeat(40_000)};\nsecond line`;
	const read = run("read", minified, { toolCallId: "min", input: { path: "/dist/app.min.js" } }, spillDir);
	const [marker, ...body] = read.text.split("\n");
	assert.match(marker, /^\[compact: kept the first [\d.]+KB of [\d.]+KB, cut inside line 1 of 2; full output: .*min\.txt\]$/);
	assert.ok(!read.text.includes("offset="), "a mid-line cut has no line offset to continue from");
	assert.ok(body.join("\n").startsWith("var a=é"));
	assert.ok(!read.text.includes("�"), "no half character");
	assert.ok(Buffer.byteLength(body.join("\n")) <= DEFAULT_CAPS.read);
	assert.equal(readFileSync(read.spillPath!, "utf8"), minified);

	const report = run("delegate", "x".repeat(DEFAULT_CAPS.delegate * 2), {}, spillDir);
	assert.ok(report.text.split("\n")[1]?.startsWith("xxx"), "the kept head is not replaced by the marker alone");
});

test("a cut that does not reclaim its marker's bytes leaves the result whole", () => {
	const spillDir = join(tempAgentDir(), "spill");
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
	const line = (i: number) => `row ${i} ${words[i % 7]} ${"q".repeat(40)} ${i * 7919}`;
	const lines: string[] = [];
	while (Buffer.byteLength(lines.join("\n")) <= DEFAULT_CAPS.bash + 20) lines.push(line(lines.length));
	const near = run("bash", lines.join("\n"), { toolCallId: "near" }, spillDir);
	assert.equal(near.text, lines.join("\n"));
	assert.equal(near.spillPath, undefined);
	assert.ok(!existsSync(join(spillDir, "near.txt")), "no spill for a result left whole");
	for (let k = 0; k < 20; k++) lines.push(line(lines.length));
	const over = run("bash", lines.join("\n"), { toolCallId: "over" }, spillDir);
	assert.ok(over.after < over.before);
	assert.ok(over.spillPath && existsSync(over.spillPath));
});

test("head-kept tools put the marker on top", () => {
	const lines = Array.from({ length: 800 }, (_, i) => `src/file${i}.ts:${i}: match ${"z".repeat(10)}`);
	const r = run("grep", lines.join("\n"));
	assert.ok(r.text.startsWith("[compact: kept "));
	assert.ok(r.text.includes(lines[0]));
	assert.ok(!r.text.includes(lines[799]));
});

test("error results keep the last 40 lines intact", () => {
	const lines = Array.from({ length: 2000 }, (_, i) => `frame ${i}: ${"e".repeat(40)}`);
	const r = run("bash", lines.join("\n"), { isError: true });
	const out = r.text.split("\n");
	assert.match(out[out.length - 1], /^\[compact: kept \d+ of 2000 lines/);
	const tail = out.slice(-41, -1);
	assert.deepEqual(tail, lines.slice(-40));
	assert.ok(!r.text.includes("[+"), "errors are not folded");
	// Even when the cap is tiny, 40 lines survive.
	const tiny = compactOutput({ toolName: "bash", toolCallId: "e", input: {}, text: lines.join("\n"), isError: true }, { ...cfg, caps: { ...DEFAULT_CAPS, bash: 100 } }, tr, join(tempAgentDir(), "spill"));
	assert.deepEqual(tiny.text.split("\n").slice(-41, -1), lines.slice(-40));
});

test("policy: unknown tools get the default head cap, session tools their own", () => {
	assert.equal(policyFor("session_search", {}, DEFAULT_CAPS).cap, DEFAULT_CAPS.session);
	assert.equal(policyFor("mystery", {}, DEFAULT_CAPS).cap, DEFAULT_CAPS.default);
	assert.equal(policyFor("bash", {}, DEFAULT_CAPS).keep, "tail");
	assert.equal(policyFor("read", { path: "a.log" }, DEFAULT_CAPS).mask, true);
	assert.equal(policyFor("read", { path: "a.ts" }, DEFAULT_CAPS).mask, false);
});

test("module hook: rewrites text blocks, keeps images, records the ledger, skips keepalive", async () => {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	const image = { type: "image", data: "abc", mimeType: "image/png" };
	const result = await pi.chainToolResult(
		{ toolName: "bash", toolCallId: "1", input: { command: "ls" }, content: [{ type: "text", text: "\u001b[1mbold\u001b[0m\n" }, image], details: {}, isError: false },
		makeCtx(),
	);
	assert.deepEqual(result.content, [{ type: "text", text: "bold" }, image]);
	const rows = new Map(kit.ledger.entries());
	assert.ok(rows.get("compact")?.count === 1);

	const untouched = await pi.chainToolResult({ toolName: "bash", toolCallId: "2", input: {}, content: [{ type: "text", text: "plain" }], details: {}, isError: false }, makeCtx());
	assert.deepEqual(untouched.content, [{ type: "text", text: "plain" }]);

	const keepalive = { toolName: "bash", toolCallId: "3", input: {}, content: [{ type: "text", text: "\u001b[1mx\u001b[0m" }], details: { keepalive: { running: true } }, isError: false };
	const skipped = await pi.chainToolResult(keepalive, makeCtx());
	assert.equal(skipped.content, keepalive.content);

	// A bash job collected through `wait` keeps the bash profile: tail kept, marker at the bottom.
	const build = Array.from({ length: 900 }, (_, i) => `task ${i} ${["compile", "link", "test"][i % 3]} ${"b".repeat(30)} ${i * 7919}`).join("\n");
	const collected = await pi.chainToolResult(
		{ toolName: "wait", toolCallId: "4", input: { id: "b-1" }, content: [{ type: "text", text: build }], details: { keepalive: { running: false, id: "b-1", tool: "bash" } }, isError: false },
		makeCtx(),
	);
	const out = collected.content[0].text as string;
	assert.match(out.split("\n").at(-1)!, /^\[compact: kept \d+ of 900 lines/);
	assert.ok(out.includes("task 899 "));

	assert.ok(pi.commands.has("compact-stats"));
	const [guidance] = await pi.emit("before_agent_start", { prompt: "hi", systemPrompt: "SYS" });
	assert.ok(guidance.systemPrompt.startsWith("SYS\n\n"));
	assert.ok(guidance.systemPrompt.split(/\s+/).length < 70);
});
