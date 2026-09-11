/**
 * Web search backends, pi-free.
 *
 * Tried in order, each falling through to the next on failure or on an empty
 * answer: Brave, Tavily, Serper (keyed; skipped without a key), then Exa's
 * public MCP endpoint and DuckDuckGo's HTML endpoint (keyless). DuckDuckGo is
 * queried sequentially because it answers bursts with HTTP 202.
 *
 * Everything goes through an injectable `fetchImpl` so tests run on fixtures.
 */
import { decodeEntities } from "./html.ts";
import { DEFAULT_TIMEOUT_MS, delay, errorMessage, type FetchImpl, withTimeout } from "./net.ts";

export type { FetchImpl } from "./net.ts";

export const BACKENDS = ["brave", "tavily", "serper", "exa-mcp", "ddg"] as const;
export type BackendName = (typeof BACKENDS)[number];
export const KEYED_BACKENDS = ["brave", "tavily", "serper"] as const;
export type KeyedBackend = (typeof KEYED_BACKENDS)[number];
export type SearchKeys = Partial<Record<KeyedBackend, string>>;

export const RECENCIES = ["day", "week", "month", "year"] as const;
export type Recency = (typeof RECENCIES)[number];
/** DuckDuckGo `df`, Brave `freshness` (prefixed `p`), Serper `tbs=qdr:`. */
const RECENCY_LETTER: Record<Recency, string> = { day: "d", week: "w", month: "m", year: "y" };

export const MAX_QUERIES = 5;
export const DEFAULT_COUNT = 6;
export const MAX_COUNT = 10;
export const MAX_SNIPPET_CHARS = 180;
/** Waits after a DuckDuckGo 202, shared across the queries of one call. */
export const DDG_RETRY_DELAYS_MS = [400, 1200];

const DDG_URL = "https://html.duckduckgo.com/html/";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const EXA_MCP_TOOL = "web_search_exa";
/** A plain browser UA: DuckDuckGo serves an anomaly page to some Chrome UAs. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** Publication date when the backend reports one (ISO date where possible). */
	date?: string;
}

export interface SearchRequest {
	/** One to MAX_QUERIES queries; results are deduped across them. */
	queries: string[];
	/** Results per query, 1..MAX_COUNT (default DEFAULT_COUNT). */
	count?: number;
	recency?: Recency;
	allowedDomains?: string[];
	blockedDomains?: string[];
	keys?: SearchKeys;
	fetchImpl?: FetchImpl;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Override the DuckDuckGo retry ladder (tests pass `[0]`). */
	ddgDelays?: number[];
}

export interface SearchGroup {
	query: string;
	results: SearchResult[];
}

export interface SearchAttempt {
	backend: BackendName;
	ok: boolean;
	note: string;
}

export interface SearchOutcome {
	/** The backend that answered; undefined when none did. */
	backend?: BackendName;
	groups: SearchGroup[];
	attempts: SearchAttempt[];
	total: number;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const ENV_KEYS: Record<KeyedBackend, string> = { brave: "BRAVE_API_KEY", tavily: "TAVILY_API_KEY", serper: "SERPER_API_KEY" };

/** Env vars win over stored config; empty strings count as unset. */
export function resolveKeys(config: SearchKeys | undefined, env: NodeJS.ProcessEnv = process.env): SearchKeys {
	const out: SearchKeys = {};
	for (const backend of KEYED_BACKENDS) {
		const value = env[ENV_KEYS[backend]]?.trim() || config?.[backend]?.trim();
		if (value) out[backend] = value;
	}
	return out;
}

export function isKeyed(backend: BackendName): backend is KeyedBackend {
	return (KEYED_BACKENDS as readonly string[]).includes(backend);
}

// ── Text helpers ─────────────────────────────────────────────────────────────

function tidy(s: string): string {
	return decodeEntities(s.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

/** Cut a snippet on a word boundary; a snippet only decides whether the URL is worth fetching. */
export function capSnippet(s: string): string {
	const text = tidy(s);
	if (text.length <= MAX_SNIPPET_CHARS) return text;
	const cut = text.slice(0, MAX_SNIPPET_CHARS);
	const space = cut.lastIndexOf(" ");
	return `${(space > MAX_SNIPPET_CHARS * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function dateOf(raw: string): string | undefined {
	const s = raw.trim();
	if (!s || s === "N/A") return undefined;
	const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
	return iso ? iso[1] : s.slice(0, 24);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function result(title: unknown, url: unknown, snippet: unknown, date?: unknown): SearchResult {
	const r: SearchResult = { title: tidy(str(title)), url: str(url).trim(), snippet: capSnippet(str(snippet)) };
	const when = dateOf(str(date));
	if (when) r.date = when;
	return r;
}

function valid(r: SearchResult): boolean {
	return r.title !== "" && /^https?:\/\//i.test(r.url);
}

function rows(payload: unknown, path: string[]): Record<string, unknown>[] {
	let node: unknown = payload;
	for (const key of path) node = (node as Record<string, unknown> | undefined)?.[key];
	return Array.isArray(node) ? (node as Record<string, unknown>[]) : [];
}

/** Fragment and trailing slash are not identity; two hits on one page are one result. */
export function canonicalUrl(url: string): string {
	return url.replace(/#.*$/, "").replace(/\/+$/, "");
}

// ── Domain filters ───────────────────────────────────────────────────────────

function normalizeDomain(domain: string): string {
	return domain
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/.*$/, "");
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return "";
	}
}

/** A domain matches itself and its subdomains on a label boundary: "example.org" ≠ "notexample.org". */
export function applyDomainFilters(results: SearchResult[], allowed: string[] = [], blocked: string[] = []): SearchResult[] {
	const allow = allowed.map(normalizeDomain).filter(Boolean);
	const block = blocked.map(normalizeDomain).filter(Boolean);
	if (allow.length === 0 && block.length === 0) return results;
	const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
	return results.filter((r) => {
		const host = hostOf(r.url);
		if (!host) return false;
		if (allow.length > 0 && !allow.some((d) => matches(host, d))) return false;
		if (block.length > 0 && block.some((d) => matches(host, d))) return false;
		return true;
	});
}

/** Fold the filters into the query as `site:` terms for engines that rank before we filter. */
export function withSiteFilters(query: string, allowed: string[] = [], blocked: string[] = []): string {
	const allow = allowed.map(normalizeDomain).filter(Boolean);
	const block = blocked.map(normalizeDomain).filter(Boolean);
	const parts = [query];
	if (allow.length === 1) parts.push(`site:${allow[0]}`);
	else if (allow.length > 1) parts.push(`(${allow.map((d) => `site:${d}`).join(" OR ")})`);
	for (const d of block) parts.push(`-site:${d}`);
	return parts.join(" ");
}

// ── Requests ─────────────────────────────────────────────────────────────────

interface Ctx {
	count: number;
	recency?: Recency;
	allowed: string[];
	blocked: string[];
	keys: SearchKeys;
	fetchImpl: FetchImpl;
	signal?: AbortSignal;
	timeoutMs: number;
	ddg: { delays: number[]; next: number };
}

async function request(ctx: Ctx, url: string, init: RequestInit, label: string): Promise<{ status: number; text: string; headers: Headers }> {
	const { signal, done } = withTimeout(ctx.signal, ctx.timeoutMs, label);
	try {
		const res = await ctx.fetchImpl(url, { ...init, signal });
		return { status: res.status, text: await res.text(), headers: res.headers };
	} finally {
		done();
	}
}

async function requestJson(ctx: Ctx, url: string, init: RequestInit, label: string): Promise<unknown> {
	const { status, text } = await request(ctx, url, init, label);
	if (status >= 400) throw new Error(`${label} HTTP ${status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} returned a non-JSON response`);
	}
}

/** Over-fetch when a filter will discard some of what comes back and the engine has no native filter. */
function askCount(ctx: Ctx, native: boolean): number {
	const filtered = ctx.allowed.length > 0 || ctx.blocked.length > 0;
	return Math.min(filtered && !native ? ctx.count * 3 : ctx.count, 20);
}

// ── Brave ────────────────────────────────────────────────────────────────────

export function parseBrave(payload: unknown): SearchResult[] {
	return rows(payload, ["web", "results"])
		.map((r) => result(r.title, r.url, r.description, r.age))
		.filter(valid);
}

async function searchBrave(query: string, ctx: Ctx): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", withSiteFilters(query, ctx.allowed, ctx.blocked));
	url.searchParams.set("count", String(askCount(ctx, false)));
	if (ctx.recency) url.searchParams.set("freshness", `p${RECENCY_LETTER[ctx.recency]}`);
	const payload = await requestJson(ctx, url.href, { headers: { Accept: "application/json", "X-Subscription-Token": ctx.keys.brave ?? "" } }, "Brave");
	return parseBrave(payload);
}

// ── Tavily ───────────────────────────────────────────────────────────────────

export function parseTavily(payload: unknown): SearchResult[] {
	return rows(payload, ["results"])
		.map((r) => result(r.title, r.url, r.content, r.published_date))
		.filter(valid);
}

async function searchTavily(query: string, ctx: Ctx): Promise<SearchResult[]> {
	const key = ctx.keys.tavily ?? "";
	const payload = await requestJson(
		ctx,
		"https://api.tavily.com/search",
		{
			method: "POST",
			// Bearer is the current scheme, api_key the legacy one; both keep it working across their migration.
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({
				api_key: key,
				query,
				max_results: askCount(ctx, true),
				...(ctx.allowed.length > 0 ? { include_domains: ctx.allowed.map(normalizeDomain) } : {}),
				...(ctx.blocked.length > 0 ? { exclude_domains: ctx.blocked.map(normalizeDomain) } : {}),
				...(ctx.recency ? { time_range: ctx.recency } : {}),
			}),
		},
		"Tavily",
	);
	return parseTavily(payload);
}

// ── Serper ───────────────────────────────────────────────────────────────────

export function parseSerper(payload: unknown): SearchResult[] {
	return rows(payload, ["organic"])
		.map((r) => result(r.title, r.link, r.snippet, r.date))
		.filter(valid);
}

async function searchSerper(query: string, ctx: Ctx): Promise<SearchResult[]> {
	const payload = await requestJson(
		ctx,
		"https://google.serper.dev/search",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", "X-API-KEY": ctx.keys.serper ?? "" },
			body: JSON.stringify({
				q: withSiteFilters(query, ctx.allowed, ctx.blocked),
				num: askCount(ctx, false),
				...(ctx.recency ? { tbs: `qdr:${RECENCY_LETTER[ctx.recency]}` } : {}),
			}),
		},
		"Serper",
	);
	return parseSerper(payload);
}

// ── Exa MCP (keyless) ────────────────────────────────────────────────────────

/** One MCP session per fetch implementation, held as the in-flight promise so parallel queries share a handshake. */
const exaSessions = new WeakMap<FetchImpl, Promise<string>>();

async function mcpPost(ctx: Ctx, payload: unknown, session: string | undefined): Promise<{ status: number; session?: string; body: string }> {
	const { status, text, headers } = await request(
		ctx,
		EXA_MCP_URL,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(session ? { "mcp-session-id": session } : {}),
			},
			body: JSON.stringify(payload),
		},
		"Exa MCP",
	);
	return { status, session: headers.get("mcp-session-id") ?? undefined, body: text };
}

/** The reply arrives as one SSE frame or as bare JSON, depending on the server. */
function parseRpc(body: string): { result?: { content?: { type?: string; text?: string }[] }; error?: { message?: string } } {
	const frame = /^data: (.*)$/m.exec(body);
	return JSON.parse(frame ? frame[1] : body);
}

async function exaHandshake(ctx: Ctx): Promise<string> {
	const init = await mcpPost(
		ctx,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-toolkit", version: "1" } },
		},
		undefined,
	);
	if (init.status >= 400 || !init.session) throw new Error(`Exa MCP refused the handshake (HTTP ${init.status})`);
	await mcpPost(ctx, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
	return init.session;
}

function exaSessionOnce(ctx: Ctx): Promise<string> {
	let pending = exaSessions.get(ctx.fetchImpl);
	if (!pending) {
		pending = exaHandshake(ctx).catch((err) => {
			exaSessions.delete(ctx.fetchImpl);
			throw err;
		});
		exaSessions.set(ctx.fetchImpl, pending);
	}
	return pending;
}

/** Exa's MCP tool answers in prose: one `Title:`/`URL:`/`Published:`/`Highlights:` block per result. */
export function parseExaMcp(text: string): SearchResult[] {
	const results: SearchResult[] = [];
	for (const block of text.split(/^(?=Title: )/m)) {
		const title = /^Title: (.+)$/m.exec(block)?.[1];
		const url = /^URL: (\S+)$/m.exec(block)?.[1];
		if (!title || !url) continue;
		const at = block.search(/^Highlights:/m);
		const highlights = at === -1 ? "" : block.slice(at).replace(/^Highlights:[ \t]*/m, "").replace(/^\s*\.\.\.\s*$/gm, "");
		const r = result(title, url, highlights, /^Published: (.+)$/m.exec(block)?.[1]);
		if (valid(r)) results.push(r);
	}
	return results;
}

async function searchExaMcp(query: string, ctx: Ctx): Promise<SearchResult[]> {
	const callTool = (session: string) =>
		mcpPost(
			ctx,
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: EXA_MCP_TOOL, arguments: { query, numResults: askCount(ctx, false) } } },
			session,
		);
	let pending = exaSessionOnce(ctx);
	let res = await callTool(await pending);
	// A session the server has since forgotten: one re-handshake, then take the answer at face value.
	if (res.status === 400 || res.status === 404) {
		if (exaSessions.get(ctx.fetchImpl) === pending) exaSessions.delete(ctx.fetchImpl);
		pending = exaSessionOnce(ctx);
		res = await callTool(await pending);
	}
	if (res.status >= 400) throw new Error(`Exa MCP HTTP ${res.status}: ${res.body.slice(0, 120)}`);
	let payload: ReturnType<typeof parseRpc>;
	try {
		payload = parseRpc(res.body);
	} catch {
		throw new Error("Exa MCP returned a non-JSON response");
	}
	if (payload.error) throw new Error(`Exa MCP: ${payload.error.message ?? "unknown error"}`);
	const text = payload.result?.content?.find((c) => c.type === "text")?.text;
	return typeof text === "string" ? parseExaMcp(text) : [];
}

// ── DuckDuckGo (keyless) ─────────────────────────────────────────────────────

/** DDG hrefs are either direct or a redirect wrapper `//duckduckgo.com/l/?uddg=<encoded>`; ads go through y.js. */
export function unwrapDdgUrl(href: string): string | null {
	const raw = decodeEntities(href).trim();
	if (raw.includes("/y.js?")) return null;
	const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
	try {
		const url = new URL(absolute, "https://duckduckgo.com");
		const wrapped = url.searchParams.get("uddg");
		if (wrapped) return wrapped;
		return /^https?:$/.test(url.protocol) && !url.hostname.endsWith("duckduckgo.com") ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * Parse DDG's /html/ results: title anchors carry class `result__a`, snippets
 * sit in a sibling anchor (or div) with class `result__snippet`. Titles and
 * snippets are paired by document order, which outlives DDG's markup changes.
 */
export function parseDdg(html: string): SearchResult[] {
	const classOf = (attrs: string) => /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
	const items: { at: number; title?: SearchResult; snippet?: string }[] = [];
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
		if (!/\bresult__a\b/.test(classOf(m[1]))) continue;
		const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1]);
		const url = href ? unwrapDdgUrl(href[1] ?? href[2] ?? "") : null;
		const title = tidy(m[2]);
		if (url && title) items.push({ at: m.index, title: { title, url, snippet: "" } });
	}
	// The class is matched inside the opening tag: a bare `<div>…</div>` scan would let an
	// outer wrapper div swallow the snippet anchors nested in it.
	for (const m of html.matchAll(/<(a|td|div|span)\b[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
		items.push({ at: m.index, snippet: capSnippet(m[2]) });
	}
	items.sort((a, b) => a.at - b.at);
	const results: SearchResult[] = [];
	for (const item of items) {
		if (item.title) {
			results.push(item.title);
			continue;
		}
		const last = results[results.length - 1];
		if (last && !last.snippet && item.snippet) last.snippet = item.snippet;
	}
	return results;
}

async function searchDdg(query: string, ctx: Ctx): Promise<SearchResult[]> {
	// POST, not GET: the GET form starts answering 202 after a few requests from one address.
	const body = new URLSearchParams({ q: withSiteFilters(query, ctx.allowed, ctx.blocked), kl: "wt-wt" });
	if (ctx.recency) body.set("df", RECENCY_LETTER[ctx.recency]);
	for (;;) {
		const { status, text } = await request(
			ctx,
			DDG_URL,
			{
				method: "POST",
				headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
				body: body.toString(),
			},
			"DuckDuckGo",
		);
		const limited = status === 202 || status === 429 || /anomaly|unusual traffic|challenge-form/i.test(text.slice(0, 2000));
		if (!limited) {
			if (status >= 400) throw new Error(`DuckDuckGo HTTP ${status}`);
			return parseDdg(text);
		}
		const wait = ctx.ddg.delays[ctx.ddg.next++];
		if (wait === undefined) throw new Error("DuckDuckGo is rate-limiting this address (HTTP 202); wait a minute or configure a key");
		await delay(Math.round(wait * (0.75 + Math.random() * 0.5)), ctx.signal);
	}
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const RUNNERS: Record<BackendName, (query: string, ctx: Ctx) => Promise<SearchResult[]>> = {
	brave: searchBrave,
	tavily: searchTavily,
	serper: searchSerper,
	"exa-mcp": searchExaMcp,
	ddg: searchDdg,
};

/** Backends that will be tried for these keys, in order. */
export function availableBackends(keys: SearchKeys): BackendName[] {
	return BACKENDS.filter((b) => !isKeyed(b) || Boolean(keys[b]));
}

async function runQueries(backend: BackendName, queries: string[], ctx: Ctx): Promise<PromiseSettledResult<SearchResult[]>[]> {
	const run = RUNNERS[backend];
	if (backend !== "ddg") return Promise.allSettled(queries.map((q) => run(q, ctx)));
	// Sequential: DuckDuckGo answers bursts from one address with 202.
	const out: PromiseSettledResult<SearchResult[]>[] = [];
	for (const q of queries) {
		if (out.length > 0 && out[out.length - 1].status === "rejected") {
			out.push(out[out.length - 1]);
			continue;
		}
		try {
			out.push({ status: "fulfilled", value: await run(q, ctx) });
		} catch (reason) {
			out.push({ status: "rejected", reason });
		}
	}
	return out;
}

/** Filter, dedupe across queries (first query wins) and trim to `count` per query. */
function assemble(queries: string[], settled: PromiseSettledResult<SearchResult[]>[], ctx: Ctx): SearchGroup[] {
	const seen = new Set<string>();
	return queries.map((query, i) => {
		const s = settled[i];
		const raw = s.status === "fulfilled" ? s.value : [];
		const results: SearchResult[] = [];
		for (const r of applyDomainFilters(raw, ctx.allowed, ctx.blocked)) {
			const key = canonicalUrl(r.url);
			if (seen.has(key)) continue;
			seen.add(key);
			results.push(r);
			if (results.length >= ctx.count) break;
		}
		return { query, results };
	});
}

export async function search(req: SearchRequest): Promise<SearchOutcome> {
	const queries = [...new Set(req.queries.map((q) => q.trim()).filter(Boolean))].slice(0, MAX_QUERIES);
	if (queries.length === 0) throw new Error("web_search needs a query");
	const count = Math.max(1, Math.min(MAX_COUNT, Math.floor(req.count ?? DEFAULT_COUNT) || DEFAULT_COUNT));
	const ctx: Ctx = {
		count,
		recency: req.recency,
		allowed: req.allowedDomains ?? [],
		blocked: req.blockedDomains ?? [],
		keys: req.keys ?? {},
		fetchImpl: req.fetchImpl ?? fetch,
		signal: req.signal,
		timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		ddg: { delays: req.ddgDelays ?? DDG_RETRY_DELAYS_MS, next: 0 },
	};
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("aborted");

	const attempts: SearchAttempt[] = [];
	for (const backend of availableBackends(ctx.keys)) {
		if (backend === "exa-mcp" && ctx.recency) {
			attempts.push({ backend, ok: false, note: "exa-mcp: no recency filter" });
			continue;
		}
		const settled = await runQueries(backend, queries, ctx);
		const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
		if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("aborted");
		if (failures.length === settled.length) {
			attempts.push({ backend, ok: false, note: `${backend}: ${errorMessage(failures[0].reason)}` });
			continue;
		}
		const groups = assemble(queries, settled, ctx);
		const total = groups.reduce((n, g) => n + g.results.length, 0);
		if (total === 0) {
			attempts.push({ backend, ok: true, note: `${backend}: no results` });
			continue;
		}
		const partial = failures.length > 0 ? ` (${failures.length} of ${settled.length} queries failed: ${errorMessage(failures[0].reason)})` : "";
		attempts.push({ backend, ok: true, note: `${backend}: ${total} results${partial}` });
		return { backend, groups, attempts, total };
	}
	return { backend: undefined, groups: queries.map((query) => ({ query, results: [] })), attempts, total: 0 };
}

/** Compact text for the model: `N. title — url (date)` then an indented snippet. */
export function formatSearch(outcome: SearchOutcome): string {
	if (outcome.total === 0) {
		const notes = outcome.attempts.map((a) => a.note);
		return ["No results.", ...(notes.length > 0 ? notes : ["no search backend available"])].join("\n");
	}
	const lines: string[] = [];
	const multi = outcome.groups.length > 1;
	let n = 0;
	for (const group of outcome.groups) {
		if (multi) {
			if (lines.length > 0) lines.push("");
			lines.push(`## ${group.query}${group.results.length === 0 ? " (no new results)" : ""}`);
		}
		for (const r of group.results) {
			n++;
			lines.push(`${n}. ${r.title} — ${r.url}${r.date ? ` (${r.date})` : ""}`);
			if (r.snippet) lines.push(`   ${r.snippet}`);
		}
	}
	return lines.join("\n");
}
