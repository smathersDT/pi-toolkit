import { test } from "node:test";
import assert from "node:assert/strict";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";
import { foldValidationEcho, foldValidationMessages } from "../validation.ts";

const FILE_BODY = Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`).join("\n");

/** pi's own message, so a reworded upgrade fails here rather than silently folding nothing. */
function piValidationError(args: Record<string, unknown>): string {
	const tool = { name: "write", description: "w", parameters: Type.Object({ path: Type.String(), content: Type.String() }) };
	try {
		validateToolArguments(tool as any, { type: "toolCall", id: "t1", name: "write", arguments: args } as any);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a validation failure");
}

test("the echoed arguments are described by key and size, the diagnosis kept", () => {
	const text = piValidationError({ content: FILE_BODY });
	assert.ok(text.includes("Received arguments:"), "pi still echoes the call");
	const folded = foldValidationEcho(text);
	assert.ok(folded);
	assert.ok(folded.startsWith('Validation failed for tool "write":'));
	assert.ok(folded.includes("path"), "the missing property is still named");
	assert.ok(folded.includes(`content: string (${FILE_BODY.length.toLocaleString("en-US")} chars)`), folded);
	assert.ok(!folded.includes("value199"));
	assert.ok(Buffer.byteLength(folded) < 400);
	assert.equal(foldValidationEcho(folded), undefined, "folds once");
	assert.equal(foldValidationEcho("Error: ENOENT"), undefined);
});

test("only error tool results change, and untouched messages keep their identity", () => {
	const text = piValidationError({ content: FILE_BODY });
	const user = { role: "user", content: text };
	const ok = { role: "toolResult", toolCallId: "a", isError: false, content: [{ type: "text", text }] };
	const failed = { role: "toolResult", toolCallId: "b", isError: true, content: [{ type: "text", text }, { type: "image", data: "x" }] };
	const r = foldValidationMessages([user, ok, failed]);
	assert.ok(r);
	assert.equal(r.messages[0], user);
	assert.equal(r.messages[1], ok);
	assert.notEqual(r.messages[2], failed);
	assert.equal((r.messages[2].content as any[])[1], failed.content[1]);
	assert.deepEqual(r.folded.map((f) => f.toolCallId), ["b"]);
	assert.equal(foldValidationMessages(r.messages), undefined, "a folded list folds to nothing");
});

test("module hook: context folds on every request, books the ledger once", async () => {
	tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	await module.setup(pi as any, kit);
	const text = piValidationError({ content: FILE_BODY });
	const messages = [{ role: "toolResult", toolCallId: "c", toolName: "write", isError: true, content: [{ type: "text", text }] }];
	const [first] = await pi.emit("context", { type: "context", messages }, makeCtx());
	const [second] = await pi.emit("context", { type: "context", messages }, makeCtx());
	assert.equal(first.messages[0].content[0].text, second.messages[0].content[0].text, "same bytes every request");
	assert.ok(first.messages[0].content[0].text.length < text.length / 5);
	assert.equal(new Map(kit.ledger.entries()).get("compact:echo")?.count, 1);
	const [none] = await pi.emit("context", { type: "context", messages: [{ role: "user", content: "hi" }] }, makeCtx());
	assert.equal(none, undefined);
});
