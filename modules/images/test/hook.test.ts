import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";

/** A PNG header with an IHDR chunk, which is all the parser reads. */
function pngHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}

async function setup(settings: Record<string, unknown> = {}) {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {}, ...settings });
	await module.setup(pi as any, kit);
	return { pi, kit };
}

const anthropic = { provider: "anthropic", id: "claude-x", reasoning: true };

function readResult(data: string) {
	return {
		toolName: "read",
		toolCallId: "1",
		input: { path: "shot.png" },
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: undefined,
		isError: false,
	};
}

test("a small image passes through untouched but gets its dimensions in details", async () => {
	const { pi, kit } = await setup();
	const data = Buffer.from(pngHeader(2560, 1440)).toString("base64");
	const result = await pi.chainToolResult(readResult(data), makeCtx({ model: anthropic }));
	assert.equal(result.content[1].data, data);
	assert.equal(result.content.length, 2);
	assert.deepEqual(result.details, { images: [{ before: { width: 2560, height: 1440, bytes: data.length }, after: { width: 2560, height: 1440, bytes: data.length }, tokens: 0 }] });
	assert.deepEqual(kit.ledger.entries(), []);
});

test("a non-Anthropic model with no cap never resizes, whatever the size", async () => {
	const { pi } = await setup({ images: { minBytes: 0 } });
	const data = Buffer.from(pngHeader(4000, 4000)).toString("base64");
	const result = await pi.chainToolResult(readResult(data), makeCtx({ model: { provider: "google", id: "gemini", reasoning: false } }));
	assert.equal(result.content[1].data, data);
	assert.equal(result.details.images[0].before.width, 4000);
});

test("results without images are left alone; prior details are preserved", async () => {
	const { pi } = await setup();
	const payload = { toolName: "bash", toolCallId: "2", input: {}, content: [{ type: "text", text: "ok" }], details: { code: 0 }, isError: false };
	const result = await pi.chainToolResult(payload, makeCtx({ model: anthropic }));
	assert.deepEqual(result.details, { code: 0 });
	const withImage = { ...readResult(Buffer.from(pngHeader(10, 10)).toString("base64")), details: { truncated: false } };
	const merged = await pi.chainToolResult(withImage, makeCtx({ model: anthropic }));
	assert.equal(merged.details.truncated, false);
	assert.equal(merged.details.images.length, 1);
});

test("/images prints session totals in a frame", async () => {
	const { pi } = await setup();
	const ctx = makeCtx({ model: anthropic });
	await pi.chainToolResult(readResult(Buffer.from(pngHeader(10, 10)).toString("base64")), ctx);
	await pi.commands.get("images")!.handler("", ctx);
	const entry = pi.entries.at(-1) as { customType: string; data: { title: string; head: string[]; lines: string[] } };
	assert.equal(entry.customType, "toolkit-frame");
	assert.equal(entry.data.title, "images");
	assert.deepEqual(entry.data.head, ["provider fit"]);
	assert.match(entry.data.lines[0], /nothing resized yet — 1 image seen/);
});
