/**
 * web — web_search and web_fetch for the "web" subagent role, plus a
 * display-only `/web <query>` command in the main session.
 *
 * Cost rule: a fetched page is the largest single input an agent pulls in, and
 * it is re-sent on every later request of the session. So the tools are
 * registered only in a "web" child (`delegate({ role: "web" })`), whose context
 * is discarded when it reports back. The main session gets `/web`, whose output
 * is a transcript frame that never enters the model context. Setting
 * `toolsInMain: true` under `web` in settings.json opts the main session in.
 *
 * Keys: `web.keys.{brave,tavily,serper}` in settings (stored by `/web key …`),
 * or BRAVE_API_KEY / TAVILY_API_KEY / SERPER_API_KEY in the environment.
 * Without any key the keyless backends (Exa MCP, DuckDuckGo) are used.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FrameBottom, FrameTop, type FrameRowState, type FrameState, textOf, toLines } from "../../core/frame.ts";
import type { AnyToolDefinition, Toolkit, ToolkitModule } from "../../core/kit.ts";
import { DEFAULT_MAX_CHARS, fetchPage, MAX_MAX_CHARS, MIN_MAX_CHARS } from "./fetch.ts";
import { errorMessage } from "./net.ts";
import { DEFAULT_COUNT, formatSearch, KEYED_BACKENDS, MAX_COUNT, MAX_QUERIES, RECENCIES, resolveKeys, search, type KeyedBackend, type SearchKeys } from "./search.ts";

interface WebConfig {
	/** Register the tools in the main session too. Costly: every page lands in the main context. */
	toolsInMain: boolean;
	keys: SearchKeys;
}

const DEFAULTS: WebConfig = { toolsInMain: false, keys: {} };

// ── Frame state shared between the call and result slots ─────────────────────

interface RenderCtx {
	state?: FrameRowState;
	invalidate?: () => void;
	isError?: boolean;
}

function rowState(context: RenderCtx): FrameState {
	const s = context.state;
	if (!s?.done) return "running";
	return s.error ? "error" : "ok";
}

/** Mark the row finished so the header re-renders in its closing colour (once). */
function finishRow(context: RenderCtx): void {
	const s = context.state;
	if (!s) return;
	s.done = true;
	s.error = !!context.isError;
	if (!s.invalidated) {
		s.invalidated = true;
		// Deferred: a synchronous invalidate re-enters pi's row update mid-render.
		queueMicrotask(() => {
			try {
				context.invalidate?.();
			} catch {}
		});
	}
}

// ── Tools ────────────────────────────────────────────────────────────────────

const SEARCH_PARAMS = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query" })),
	queries: Type.Optional(Type.Array(Type.String(), { description: `Up to ${MAX_QUERIES} related queries run together; results are deduped across them` })),
	count: Type.Optional(Type.Integer({ description: `Results per query, 1-${MAX_COUNT} (default ${DEFAULT_COUNT})` })),
	recency: Type.Optional(StringEnum(RECENCIES, { description: "Only pages from the last day, week, month or year" })),
	allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only these domains (subdomains included)" })),
	blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never these domains" })),
});

const FETCH_PARAMS = Type.Object({
	url: Type.String({ description: "http(s) URL to read" }),
	max_chars: Type.Optional(Type.Integer({ description: `Character cap (default ${DEFAULT_MAX_CHARS}, ${MIN_MAX_CHARS}-${MAX_MAX_CHARS}); keep it as small as the task allows` })),
	selector: Type.Optional(Type.String({ description: 'Keep only this element of an HTML page: "main", "article" or "#some-id"' })),
});

interface SearchArgs {
	query?: string;
	queries?: string[];
	count?: number;
	recency?: (typeof RECENCIES)[number];
	allowed_domains?: string[];
	blocked_domains?: string[];
}

interface FetchArgs {
	url: string;
	max_chars?: number;
	selector?: string;
}

function searchHead(args: SearchArgs | undefined): string {
	const queries = [args?.query, ...(args?.queries ?? [])].filter((q): q is string => typeof q === "string" && q.trim() !== "");
	const extras: string[] = [];
	if (args?.recency) extras.push(`last ${args.recency}`);
	if (args?.allowed_domains?.length) extras.push(`site: ${args.allowed_domains.join(", ")}`);
	if (args?.blocked_domains?.length) extras.push(`not: ${args.blocked_domains.join(", ")}`);
	return `${queries.join(" | ") || "…"}${extras.length > 0 ? `  (${extras.join("; ")})` : ""}`;
}

function fetchHead(args: FetchArgs | undefined): string {
	return `${args?.url ?? "…"}${args?.selector ? `  [${args.selector}]` : ""}`;
}

function registerTools(pi: ExtensionAPI, cfg: WebConfig): void {
	const webSearch: AnyToolDefinition = {
		name: "web_search",
		label: "Web search",
		description:
			"Search the web. Returns ranked results as numbered `title — url (date)` lines, each with a one-line snippet. Pass `queries` (up to 5) to run related searches at once; results are deduped across them.",
		promptSnippet: "Search the web for URLs and snippets",
		parameters: SEARCH_PARAMS,
		renderShell: "self",
		async execute(_id, params: SearchArgs, signal) {
			const queries = [params.query, ...(params.queries ?? [])].filter((q): q is string => typeof q === "string" && q.trim() !== "");
			if (queries.length === 0) throw new Error("web_search: pass query or queries");
			const outcome = await search({
				queries,
				count: params.count,
				recency: params.recency,
				allowedDomains: params.allowed_domains,
				blockedDomains: params.blocked_domains,
				keys: resolveKeys(cfg.keys),
				signal,
			});
			if (outcome.total === 0 && !outcome.attempts.some((a) => a.ok)) {
				throw new Error(`web_search: ${outcome.attempts.map((a) => a.note).join("; ") || "no search backend available"}`);
			}
			return {
				content: [{ type: "text", text: formatSearch(outcome) }],
				details: { backend: outcome.backend, total: outcome.total, attempts: outcome.attempts },
			};
		},
		renderCall(args: SearchArgs, theme, context: RenderCtx) {
			return new FrameTop("WEB SEARCH", [searchHead(args)], rowState(context), theme);
		},
		renderResult(result, { expanded }, theme, context: RenderCtx) {
			finishRow(context);
			const d = (result.details ?? {}) as { backend?: string; total?: number };
			const footer = d.backend ? [`${d.total ?? 0} result${d.total === 1 ? "" : "s"} via ${d.backend}`] : [];
			return new FrameBottom({ lines: toLines(textOf(result)), expanded }, theme, footer);
		},
	};

	const webFetch: AnyToolDefinition = {
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch one http(s) URL and return its content: HTML as markdown, JSON compacted, text as-is, capped at max_chars with a truncation note. PDFs and binary files are refused.",
		promptSnippet: "Read a web page as markdown (or JSON/text)",
		promptGuidelines: [
			'Use web_search to find candidate URLs and web_fetch to read the one that matters; keep web_fetch max_chars small and pass selector "main" or "article" to skip page chrome.',
		],
		parameters: FETCH_PARAMS,
		renderShell: "self",
		async execute(_id, params: FetchArgs, signal) {
			const page = await fetchPage(params.url, { maxChars: params.max_chars, selector: params.selector, signal });
			return {
				content: [{ type: "text", text: page.text }],
				details: {
					url: page.url,
					finalUrl: page.finalUrl,
					status: page.status,
					contentType: page.contentType,
					kind: page.kind,
					title: page.title,
					chars: page.text.length,
					totalChars: page.totalChars,
					truncated: page.truncated,
					selectorMatched: page.selectorMatched,
				},
			};
		},
		renderCall(args: FetchArgs, theme, context: RenderCtx) {
			return new FrameTop("WEB FETCH", [fetchHead(args)], rowState(context), theme);
		},
		renderResult(result, { expanded }, theme, context: RenderCtx) {
			finishRow(context);
			const d = (result.details ?? {}) as { kind?: string; chars?: number; totalChars?: number; truncated?: boolean; status?: number; finalUrl?: string; url?: string };
			const footer: string[] = [];
			if (d.kind) {
				const parts = [d.kind, `${d.chars ?? 0} chars${d.truncated ? ` (truncated from ${d.totalChars})` : ""}`];
				if (d.finalUrl && d.url && d.finalUrl !== d.url) parts.push(`→ ${d.finalUrl}`);
				footer.push(parts.join(" · "));
			}
			return new FrameBottom({ lines: toLines(textOf(result)), expanded }, theme, footer);
		},
	};

	pi.registerTool(webSearch as ToolDefinition);
	pi.registerTool(webFetch as ToolDefinition);
}

// ── /web command (main session, display only) ───────────────────────────────

function handleKey(kit: Toolkit, cfg: WebConfig, backend: string | undefined, key: string | undefined): string {
	if (!backend) {
		const resolved = resolveKeys(cfg.keys);
		const status = KEYED_BACKENDS.map((b) => `${b}: ${resolved[b] ? "set" : "unset"}`).join(", ");
		return `Search keys — ${status}. Set one with /web key <backend> <key> (env BRAVE_API_KEY / TAVILY_API_KEY / SERPER_API_KEY also work).`;
	}
	const name = backend.toLowerCase();
	if (!(KEYED_BACKENDS as readonly string[]).includes(name)) return `Unknown backend "${backend}"; keyed backends: ${KEYED_BACKENDS.join(", ")}`;
	const keys: SearchKeys = { ...cfg.keys };
	if (key) keys[name as KeyedBackend] = key;
	else delete keys[name as KeyedBackend];
	cfg.keys = keys;
	const raw = kit.settings.web && typeof kit.settings.web === "object" ? (kit.settings.web as Record<string, unknown>) : {};
	kit.saveConfig("web", { ...raw, keys });
	return key ? `${name} key saved (…${key.slice(-4)})` : `${name} key removed`;
}

function registerCommand(pi: ExtensionAPI, kit: Toolkit, cfg: WebConfig): void {
	pi.registerCommand("web", {
		description: "Web search, display only: /web <query> · /web key <brave|tavily|serper> [key]",
		async handler(args, ctx) {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /web <query>  |  /web key <brave|tavily|serper> [key]", "info");
				return;
			}
			const keyCmd = /^keys?(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i.exec(text);
			if (keyCmd) {
				ctx.ui.notify(handleKey(kit, cfg, keyCmd[1], keyCmd[2]), "info");
				return;
			}
			try {
				const outcome = await search({ queries: [text], keys: resolveKeys(cfg.keys) });
				kit.print("WEB SEARCH", [text], toLines(formatSearch(outcome)), outcome.total > 0 ? "ok" : "error");
			} catch (error) {
				kit.print("WEB SEARCH", [text], [errorMessage(error)], "error");
			}
		},
	});
}

// ── Module ───────────────────────────────────────────────────────────────────

const module: ToolkitModule = {
	id: "web",
	label: "Web search & fetch",
	description: "web_search + web_fetch in the web subagent; /web <query> in the main session",
	default: true,
	order: 60,
	child: ["web"],
	setup(pi, kit) {
		const cfg = kit.config("web", DEFAULTS);
		const inWebChild = kit.role.role === "web";
		if (inWebChild || (!kit.role.isChild && cfg.toolsInMain)) registerTools(pi, cfg);
		if (!kit.role.isChild) registerCommand(pi, kit, cfg);
	},
};

export default module;
