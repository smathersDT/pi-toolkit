/**
 * URL retrieval for web_fetch, pi-free: timeout, redirects, a byte cap,
 * content-type dispatch (HTML → markdown, JSON → compact, text as-is), and a
 * character cap with a truncation note. Binary and PDF are refused.
 */
import { tidyWhitespace } from "../../core/text.ts";
import { htmlToMarkdown } from "./html.ts";
import { DEFAULT_TIMEOUT_MS, type FetchImpl, withTimeout } from "./net.ts";

export const USER_AGENT = "Mozilla/5.0 (compatible; pi-toolkit)";
export const DEFAULT_MAX_CHARS = 15_000;
export const MIN_MAX_CHARS = 500;
export const MAX_MAX_CHARS = 100_000;
/** Bytes read from the body before giving up on the rest. */
export const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPT = "text/html, application/xhtml+xml, text/*;q=0.9, application/json;q=0.9, application/xml;q=0.8, */*;q=0.1";

export type PageKind = "html" | "json" | "text";

export interface FetchPageOptions {
	maxChars?: number;
	/** "main", "article" or "#id": keep only that element of an HTML page. */
	selector?: string;
	signal?: AbortSignal;
	fetchImpl?: FetchImpl;
	timeoutMs?: number;
	maxBytes?: number;
}

export interface FetchedPage {
	url: string;
	/** After redirects. */
	finalUrl: string;
	status: number;
	contentType: string;
	kind: PageKind;
	title?: string;
	/** The content, capped; ends with a `[truncated …]` note when cut. */
	text: string;
	truncated: boolean;
	/** Characters before the cap. */
	totalChars: number;
	/** For HTML with a selector: whether it matched. */
	selectorMatched?: boolean;
}

export function clampMaxChars(n: number | undefined): number {
	if (n === undefined || !Number.isFinite(n)) return DEFAULT_MAX_CHARS;
	return Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Math.floor(n)));
}

/** One line while it still reads on one line; one-space indent once it needs structure. */
export function formatJson(raw: string): string {
	try {
		const value = JSON.parse(raw);
		const flat = JSON.stringify(value);
		return flat.length <= 1000 ? flat : JSON.stringify(value, null, 1);
	} catch {
		return raw;
	}
}

/** Cap at `limit` characters on a line boundary, so the tail is never half a sentence. */
export function clamp(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const cut = text.slice(0, limit);
	const lastBreak = cut.lastIndexOf("\n");
	return { text: (lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd(), truncated: true };
}

function parseTarget(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw.trim().replace(/^@/, ""));
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http(s) URLs are fetched, not ${url.protocol}`);
	return url;
}

function isBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 1024);
	for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
	return false;
}

function ascii(bytes: Uint8Array, n: number): string {
	return new TextDecoder("latin1").decode(bytes.subarray(0, n));
}

/** Decide how to read the body, or throw for what web_fetch refuses. */
export function kindFor(contentType: string, url: string, bytes: Uint8Array): PageKind {
	const type = contentType.split(";")[0].trim().toLowerCase();
	const untyped = type === "" || type === "application/octet-stream";
	const head = ascii(bytes, 512);
	// Servers hand out PDFs as octet-stream or even text/plain; the magic number decides.
	if (type === "application/pdf" || /^%PDF-/.test(head) || (untyped && /\.pdf$/i.test(new URL(url).pathname))) throw new Error("PDF not supported");
	if (type === "text/html" || type === "application/xhtml+xml") return "html";
	if (type === "application/json" || type.endsWith("+json") || type === "text/json") return "json";
	if (
		type.startsWith("text/") ||
		type === "application/xml" ||
		type.endsWith("+xml") ||
		type === "application/javascript" ||
		type === "application/x-javascript" ||
		type === "application/ecmascript" ||
		/^application\/(x-)?(yaml|sh|toml|csv)$/.test(type)
	) {
		if (isBinary(bytes)) throw new Error(`Not text: ${url} was served as ${type} but its body is binary`);
		return "text";
	}
	if (untyped) {
		if (isBinary(bytes)) throw new Error(`Not text: ${url} has no usable content-type and its body is binary`);
		if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(head)) return "html";
		return "text";
	}
	throw new Error(`Unsupported content type "${type}" — web_fetch reads HTML, JSON, XML and plain text only`);
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
	const body = res.body;
	if (!body) return new Uint8Array(await res.arrayBuffer());
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (bytes < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			bytes += value.byteLength;
		}
	} finally {
		// Stop the transfer rather than draining a file we already capped.
		await reader.cancel().catch(() => {});
	}
	const merged = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function decodeBody(bytes: Uint8Array, contentType: string, kind: PageKind): string {
	let charset = /charset\s*=\s*["']?([\w.-]+)/i.exec(contentType)?.[1];
	if (!charset && kind === "html") charset = /<meta[^>]+charset\s*=\s*["']?([\w.-]+)/i.exec(ascii(bytes, 2048))?.[1];
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
	const target = parseTarget(url);
	const maxChars = clampMaxChars(opts.maxChars);
	const fetchImpl = opts.fetchImpl ?? fetch;
	if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
	const { signal, done } = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, "web_fetch");
	try {
		const res = await fetchImpl(target.href, {
			headers: { "User-Agent": USER_AGENT, Accept: ACCEPT, "Accept-Language": "en" },
			redirect: "follow",
			signal,
		});
		const finalUrl = res.url || target.href;
		const contentType = res.headers.get("content-type") ?? "";
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""} for ${finalUrl}`);
		}
		const bytes = await readCapped(res, opts.maxBytes ?? MAX_BYTES);
		const kind = kindFor(contentType, finalUrl, bytes);
		const raw = decodeBody(bytes, contentType, kind);

		let title: string | undefined;
		let body: string;
		let selectorMatched: boolean | undefined;
		if (kind === "html") {
			const md = htmlToMarkdown(raw, { baseUrl: finalUrl, selector: opts.selector });
			title = md.title;
			body = md.text;
			if (opts.selector) {
				selectorMatched = md.scoped;
				if (!md.scoped) body = `[selector "${opts.selector}" not found; whole page]\n\n${body}`;
			}
			if (title && !body.startsWith(`# ${title}`)) body = `# ${title}\n\n${body}`;
		} else if (kind === "json") {
			body = formatJson(raw);
		} else {
			body = tidyWhitespace(raw);
		}

		const totalChars = body.length;
		const cut = clamp(body, maxChars);
		const text = cut.truncated ? `${cut.text}\n[truncated at ${cut.text.length} chars of ${totalChars}]` : cut.text;
		return { url: target.href, finalUrl, status: res.status, contentType, kind, title, text, truncated: cut.truncated, totalChars, selectorMatched };
	} finally {
		done();
	}
}
