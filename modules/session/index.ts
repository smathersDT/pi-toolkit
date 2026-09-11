/**
 * Session memory: answer "what did we decide about X last week" from the last
 * two weeks of session transcripts.
 *
 * The two tools cost prompt tokens on every turn, so they are registered only
 * in a child with role "session" (spawned by the subagent module with
 * PI_TOOLKIT_ROLE=session) or when `toolsInMain` is set. The main session
 * gets a display-only `/sessions <query>` command instead.
 *
 * Config (settings.json → "session"): { days: 14, toolsInMain: false }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FrameBottom, FrameTop, textOf, toLines } from "../../core/frame.ts";
import type { FrameRowState, FrameState, FrameTheme } from "../../core/frame.ts";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { DEFAULT_DAYS, read, search } from "./index-store.ts";
import type { SearchOutput } from "./index-store.ts";

const DEFAULTS = { days: DEFAULT_DAYS, toolsInMain: false };
const MAX_DAYS = 60;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

type SessionConfig = typeof DEFAULTS;

const module: ToolkitModule = {
	id: "session",
	label: "Session memory",
	description: "session_search / session_read for the session subagent; /sessions <query> in the main session",
	default: true,
	order: 65,
	child: ["session"],
	setup(pi, kit) {
		const cfg = kit.config("session", DEFAULTS);
		if (kit.role.role === "session" || cfg.toolsInMain) registerTools(pi, kit, cfg);
		if (!kit.role.isChild) registerCommand(pi, kit, cfg);
	},
};
export default module;

// ---------------------------------------------------------------------------
// Tools

function registerTools(pi: ExtensionAPI, kit: Toolkit, cfg: SessionConfig): void {
	pi.registerTool({
		name: "session_search",
		label: "Session search",
		description: `Search past pi session transcripts (user and assistant messages, last ${cfg.days} days by default) for literal terms. All terms must match; falls back to any term. Returns ranked one-line excerpts with the session id and message id to pass to session_read.`,
		promptSnippet: "Search earlier session transcripts for what was said or decided",
		promptGuidelines: [
			"Use session_search to find where a topic came up in earlier sessions, then session_read with the returned session and message ids to read the surrounding conversation before answering.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Literal search terms, case-insensitive; every term must appear in a message" }),
			days: Type.Optional(Type.Number({ description: `How many days back to look, 1-${MAX_DAYS} (default ${cfg.days})` })),
			limit: Type.Optional(Type.Number({ description: `Max results, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})` })),
			cwd: Type.Optional(Type.String({ description: "Only sessions whose working directory is this path or below" })),
		}),
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const days = clamp(params.days ?? cfg.days, 1, MAX_DAYS);
			const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
			const out = await search(kit.paths.agentDir, { query: params.query, days, limit, cwd: params.cwd, exclude: currentSessionFile(ctx) });
			kit.log("session", `search "${params.query}": ${out.results.length} results, ${out.stats.files} files (${out.stats.scanned} scanned) in ${out.stats.ms} ms`);
			const lines = formatResults(out, days);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, days, partial: out.partial, results: out.results, stats: out.stats },
			};
		},
		renderCall(args, theme, context) {
			return frameTop("SESSION SEARCH", [args.query ?? ""], theme, context);
		},
		renderResult(result, options, theme, context) {
			return frameBottom(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "session_read",
		label: "Session read",
		description: `Read one page of a past session transcript: up to 8 messages within 12000 characters, starting 2 messages before message_id, or at offset. The last line names the next offset and message id when more follows.`,
		promptSnippet: "Read a page of an earlier session transcript around a message",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session id (or the prefix printed by session_search)" }),
			message_id: Type.Optional(Type.String({ description: "Anchor message id from session_search; the page starts 2 messages before it" })),
			offset: Type.Optional(Type.Number({ description: "Message index to start from, e.g. the next offset of a previous page" })),
		}),
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const page = await read(kit.paths.agentDir, {
				sessionId: params.session_id,
				messageId: params.message_id,
				offset: params.offset,
				days: MAX_DAYS,
				exclude: currentSessionFile(ctx),
			});
			if (!page) throw new Error(`No session matches id "${params.session_id}" in the last ${MAX_DAYS} days.`);
			const name = page.name ? ` "${page.name}"` : "";
			const range = page.count > 0 ? `messages ${page.start + 1}-${page.start + page.count} of ${page.total}` : `no messages at offset ${page.start} (${page.total} total)`;
			const head = `session ${page.sessionId} ${page.cwd}${name} — ${range}`;
			const more = page.next_offset !== undefined ? `\n[more: offset ${page.next_offset}, message_id ${page.next_message_id}]` : "";
			return {
				content: [{ type: "text", text: `${head}\n${page.text}${more}` }],
				details: {
					sessionId: page.sessionId,
					file: page.file,
					start: page.start,
					count: page.count,
					total: page.total,
					next_offset: page.next_offset,
					next_message_id: page.next_message_id,
				},
			};
		},
		renderCall(args, theme, context) {
			const where = `${args.session_id ?? ""}${args.message_id ? ` @${args.message_id}` : ""}${args.offset !== undefined ? ` +${args.offset}` : ""}`;
			return frameTop("SESSION READ", [where], theme, context);
		},
		renderResult(result, options, theme, context) {
			return frameBottom(result, options, theme, context);
		},
	});
}

// ---------------------------------------------------------------------------
// /sessions command (main session, display only)

function registerCommand(pi: ExtensionAPI, kit: Toolkit, cfg: SessionConfig): void {
	pi.registerCommand("sessions", {
		description: `Search the last ${cfg.days} days of session transcripts (display only)`,
		handler: async (args, ctx) => {
			const query = (args ?? "").trim();
			if (!query) {
				ctx.ui.notify("Usage: /sessions <query>", "warning");
				return;
			}
			try {
				const out = await search(kit.paths.agentDir, { query, days: cfg.days, limit: 10, exclude: currentSessionFile(ctx) });
				const head = [`${query}  (${out.stats.files} sessions, ${out.stats.scanned} indexed, ${out.stats.ms} ms)`];
				kit.print("SESSION SEARCH", head, formatResults(out, cfg.days), "ok");
			} catch (err) {
				kit.log("session", `/sessions failed: ${String(err)}`);
				ctx.ui.notify(`session search failed: ${(err as Error).message ?? String(err)}`, "error");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Formatting and frames

/** `<n>. <date> <cwd-basename> [<role>] <excerpt>  (session <id>, msg <id>)` */
export function formatResults(out: SearchOutput, days: number): string[] {
	if (out.results.length === 0) return [`No matches in the last ${days} days.`];
	const lines: string[] = [];
	if (out.partial) lines.push("No message matched every term; showing messages matching any term:");
	out.results.forEach((r, i) => {
		lines.push(`${i + 1}. ${r.date} ${cwdBase(r.cwd)} [${r.role}] ${r.excerpt}  (session ${r.shortId}, msg ${r.messageId})`);
	});
	return lines;
}

/** Last path segment, whichever slash convention the session was written with. */
function cwdBase(cwd: string): string {
	const parts = (cwd ?? "").split(/[\\/]+/).filter(Boolean);
	return parts[parts.length - 1] ?? "?";
}

function currentSessionFile(ctx: any): string | undefined {
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		return typeof file === "string" && file ? file : undefined;
	} catch {
		return undefined;
	}
}

function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo;
	return Math.min(hi, Math.max(lo, Math.round(n)));
}

function rowState(context: any): FrameState {
	const st = (context?.state ?? {}) as FrameRowState;
	return st.done ? (st.error ? "error" : "ok") : "running";
}

function frameTop(title: string, head: string[], theme: FrameTheme, context: any): FrameTop {
	const state = rowState(context);
	const last = context?.lastComponent;
	if (last instanceof FrameTop) return last.update(title, head, state);
	return new FrameTop(title, head, state, theme);
}

function frameBottom(result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: FrameTheme, context: any): FrameBottom {
	const st = (context.state ??= {}) as FrameRowState;
	if (!options.isPartial && !st.done) {
		st.done = true;
		st.error = !!context.isError;
		if (!st.invalidated) {
			st.invalidated = true;
			// Let the header repaint with the closing state once this render settles.
			queueMicrotask(() => {
				try {
					context.invalidate?.();
				} catch {}
			});
		}
	}
	const body = { lines: toLines(textOf(result)), expanded: !!options.expanded };
	const last = context?.lastComponent;
	if (last instanceof FrameBottom) return last.update(body);
	return new FrameBottom(body, theme);
}
