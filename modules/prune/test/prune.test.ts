import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import { collapseDocsSection, collapsedLine, forcedCollapse, isPiProject } from "../collapse.ts";
import module from "../index.ts";

const DOCS = "C:\\pi\\node_modules\\@earendil-works\\pi-coding-agent\\docs";
/** The block as pi's system-prompt.js emits it. */
const BLOCK = [
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
	"- Main documentation: C:\\pi\\node_modules\\@earendil-works\\pi-coding-agent\\README.md",
	`- Additional docs: ${DOCS}`,
	"- Examples: C:\\pi\\node_modules\\@earendil-works\\pi-coding-agent\\examples (extensions, custom tools, SDK)",
	"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
	"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md)",
	"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
].join("\n");
const HEAD = "You are pi.\n\nGuidelines:\n- Be terse\n\n";
const TAIL = '\n\n<project_instructions path="x">\nkeep me\n</project_instructions>';
const PROMPT = `${HEAD}${BLOCK}${TAIL}`;

test("collapseDocsSection replaces the block with one line that keeps the docs path", () => {
	const out = collapseDocsSection(PROMPT);
	assert.notEqual(out, PROMPT);
	assert.equal(out, `${HEAD}${collapsedLine(DOCS)}${TAIL}`);
	assert.ok(!out.includes("- Main documentation"));
	assert.ok(!out.includes("tui.md for TUI API details"));
	assert.ok(PROMPT.length - out.length > 400);
});

test("collapseDocsSection is idempotent", () => {
	const once = collapseDocsSection(PROMPT);
	assert.equal(collapseDocsSection(once), once);
});

test("a missing anchor leaves the prompt identity-equal", () => {
	assert.equal(collapseDocsSection("no docs here"), "no docs here");
	const noBullets = "intro\nPi documentation (read only when the user asks):\nnot a bullet";
	assert.equal(collapseDocsSection(noBullets), noBullets);
	const noPath = "intro\nPi documentation (read only when the user asks):\n- Main documentation: x\n- Examples: y\n\nafter";
	assert.equal(collapseDocsSection(noPath), noPath);
});

test("CRLF prompts collapse too, with the path trimmed", () => {
	const out = collapseDocsSection(PROMPT.replace(/\n/g, "\r\n"));
	assert.ok(out.includes(collapsedLine(DOCS)));
	assert.ok(!out.includes("- Main documentation"));
});

test("forcedCollapse reads PI_TOOLKIT_PRUNE_DOCS", () => {
	assert.equal(forcedCollapse({}), null);
	assert.equal(forcedCollapse({ PI_TOOLKIT_PRUNE_DOCS: "always" }), true);
	assert.equal(forcedCollapse({ PI_TOOLKIT_PRUNE_DOCS: " Never " }), false);
	assert.equal(forcedCollapse({ PI_TOOLKIT_PRUNE_DOCS: "maybe" }), null);
});

test("isPiProject: the agent dir, anything under it, and a package depending on pi", () => {
	const agent = mkdtempSync(join(tmpdir(), "pi-toolkit-agent-"));
	assert.equal(isPiProject(agent, agent), true);
	assert.equal(isPiProject(join(agent, "extensions", "x"), agent), true);

	const sdk = mkdtempSync(join(tmpdir(), "pi-toolkit-sdk-"));
	writeFileSync(join(sdk, "package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-coding-agent": "*" } }));
	mkdirSync(join(sdk, "src", "deep"), { recursive: true });
	assert.equal(isPiProject(sdk, agent), true);
	assert.equal(isPiProject(join(sdk, "src", "deep"), agent), true, "the walk goes up");

	const plain = mkdtempSync(join(tmpdir(), "pi-toolkit-plain-"));
	writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "widgets", dependencies: { react: "*" } }));
	assert.equal(isPiProject(plain, agent), false);

	const broken = mkdtempSync(join(tmpdir(), "pi-toolkit-broken-"));
	writeFileSync(join(broken, "package.json"), "{ not json");
	assert.equal(isPiProject(broken, agent), false);
});

async function setup(settings: Record<string, unknown> = {}) {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {}, ...settings });
	await module.setup(pi as any, kit);
	return { pi, kit };
}

function plainProject(): string {
	return mkdtempSync(join(tmpdir(), "pi-toolkit-cwd-"));
}

test("session_start holds find and ls out of the active set", async () => {
	const { pi } = await setup();
	await pi.emit("session_start", { reason: "startup" }, makeCtx({ cwd: plainProject() }));
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "grep"]);
});

test("dropTools replaces the list; names not registered are ignored", async () => {
	const { pi } = await setup({ prune: { dropTools: ["grep", "nope"] } });
	await pi.emit("session_start", { reason: "startup" }, makeCtx({ cwd: plainProject() }));
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "find", "ls"]);
});

test("a subagent child keeps every tool", async () => {
	process.env.PI_TOOLKIT_DEPTH = "1";
	try {
		const { pi } = await setup();
		await pi.emit("session_start", { reason: "startup" }, makeCtx({ cwd: plainProject() }));
		assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	} finally {
		delete process.env.PI_TOOLKIT_DEPTH;
	}
});

test("before_agent_start collapses outside a pi project and leaves a pi project alone", async () => {
	const { pi } = await setup();
	const [result] = await pi.emit("before_agent_start", { systemPrompt: PROMPT }, makeCtx({ cwd: plainProject() }));
	assert.equal(result?.systemPrompt, `${HEAD}${collapsedLine(DOCS)}${TAIL}`);

	const { pi: inside, kit } = await setup();
	const [untouched] = await inside.emit("before_agent_start", { systemPrompt: PROMPT }, makeCtx({ cwd: join(kit.paths.agentDir, "extensions") }));
	assert.equal(untouched, undefined);
});

test("PI_TOOLKIT_PRUNE_DOCS overrides the heuristic both ways", async () => {
	process.env.PI_TOOLKIT_PRUNE_DOCS = "never";
	try {
		const { pi } = await setup();
		const [result] = await pi.emit("before_agent_start", { systemPrompt: PROMPT }, makeCtx({ cwd: plainProject() }));
		assert.equal(result, undefined);
	} finally {
		delete process.env.PI_TOOLKIT_PRUNE_DOCS;
	}
	process.env.PI_TOOLKIT_PRUNE_DOCS = "always";
	try {
		const { pi, kit } = await setup();
		const [result] = await pi.emit("before_agent_start", { systemPrompt: PROMPT }, makeCtx({ cwd: kit.paths.agentDir }));
		assert.ok(result?.systemPrompt.includes(collapsedLine(DOCS)));
	} finally {
		delete process.env.PI_TOOLKIT_PRUNE_DOCS;
	}
});

test("docs: false keeps the section", async () => {
	const { pi } = await setup({ prune: { docs: false } });
	const [result] = await pi.emit("before_agent_start", { systemPrompt: PROMPT }, makeCtx({ cwd: plainProject() }));
	assert.equal(result, undefined);
});

test("/prune prints what is held out in a frame", async () => {
	const { pi } = await setup();
	const ctx = makeCtx({ cwd: plainProject() });
	await pi.emit("session_start", { reason: "startup" }, ctx);
	await pi.emit("before_agent_start", { systemPrompt: PROMPT }, ctx);
	await pi.commands.get("prune")!.handler("", ctx);
	const entry = pi.entries.at(-1) as { customType: string; data: { title: string; lines: string[] } };
	assert.equal(entry.customType, "toolkit-frame");
	assert.equal(entry.data.title, "prune");
	assert.match(entry.data.lines[0], /~\d+ tokens/);
	assert.match(entry.data.lines[1], /holding back find, ls/);
});
