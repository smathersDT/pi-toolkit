/**
 * A tool-call validation failure, without the echo. Pure: no pi imports.
 *
 * pi answers a call that fails schema validation with the diagnosis and then
 * the whole call back:
 *
 *     Validation failed for tool "write":
 *       - path: must have required properties path
 *
 *     Received arguments:
 *     { "content": "…the entire file…" }
 *
 * The arguments are already in the prefix (the toolCall block the model just
 * wrote), so the echo doubles them on every later request. The diagnosis names
 * the property that was wrong; the values the model has.
 *
 * pi never hands this result to `tool_result`: it is an "immediate" result in
 * the agent loop's prepareToolCall. So it is folded on the way out, in the
 * `context` hook. That is cache-safe because the fold is a pure function of the
 * stored text: the provider sees the folded form from the first request that
 * carries the message, and the same form after.
 */
import { byteLength } from "../../core/text.ts";

const ECHO = /^(Validation failed for tool "[^"]*":[\s\S]*?)\s*Received arguments:\s*/;

/** Part of the folded text, and the mark that stops it being folded twice. */
const FOLDED_MARK = "are not repeated here";

/** The folded text, or undefined when this is not a validation failure (or is one already folded). */
export function foldValidationEcho(text: string): string | undefined {
	const m = ECHO.exec(text);
	if (m === null || text.includes(FOLDED_MARK)) return undefined;
	const diagnosis = m[1].trimEnd();
	const rest = text.slice(m[0].length);
	let described: string;
	try {
		const args: unknown = JSON.parse(rest);
		described =
			args !== null && typeof args === "object" && !Array.isArray(args)
				? `{ ${Object.entries(args as Record<string, unknown>)
						.map(([k, v]) => `${k}: ${describe(v)}`)
						.join(", ")} }`
				: describe(args);
	} catch {
		// Not the JSON expected: a glimpse and the size rather than a guess.
		described = `${rest.slice(0, 120).replace(/\s+/g, " ")}… (${rest.length.toLocaleString("en-US")} chars)`;
	}
	const folded = `${diagnosis}\nReceived arguments: ${described} — the values are the ones in your call and ${FOLDED_MARK}. Re-issue the call with the property named above fixed.`;
	return byteLength(folded) < byteLength(text) ? folded : undefined;
}

/** One argument by type and size; a short string by value, since a path is worth seeing. */
function describe(v: unknown): string {
	if (typeof v === "string") return v.length <= 60 ? JSON.stringify(v) : `string (${v.length.toLocaleString("en-US")} chars)`;
	if (Array.isArray(v)) return `array (${v.length} item${v.length === 1 ? "" : "s"})`;
	if (v !== null && typeof v === "object") return `object (${Object.keys(v).join(", ")})`;
	return JSON.stringify(v) ?? String(v);
}

/** The little of a message this needs, structurally, so it stays host-free. */
export interface EchoMessage {
	role: string;
	isError?: boolean;
	toolCallId?: string;
	content?: unknown;
}

export interface FoldedEcho {
	toolCallId: string;
	before: number;
	after: number;
}

/**
 * The message list with every validation failure folded, or undefined when
 * there was none. Untouched messages keep their identity, and a folded list
 * folds to nothing a second time.
 */
export function foldValidationMessages<M extends EchoMessage>(messages: M[]): { messages: M[]; folded: FoldedEcho[] } | undefined {
	const folded: FoldedEcho[] = [];
	const out = messages.map((m) => {
		if (m.role !== "toolResult" || m.isError !== true || !Array.isArray(m.content)) return m;
		const blocks = m.content as Array<{ type?: unknown; text?: unknown }>;
		const first = blocks.find((c) => c?.type === "text" && typeof c.text === "string");
		if (first === undefined) return m;
		const text = foldValidationEcho(first.text as string);
		if (text === undefined) return m;
		folded.push({ toolCallId: m.toolCallId ?? "", before: byteLength(first.text as string), after: byteLength(text) });
		return { ...m, content: blocks.map((c) => (c === first ? { ...c, text } : c)) };
	});
	return folded.length > 0 ? { messages: out, folded } : undefined;
}
