/**
 * Parsers for the three official price pages. Pure functions: HTML or markdown
 * in, numbers out, `undefined` when the layout is not the one we know. A page
 * that changed shape keeps the old prices; it never writes garbage.
 *
 * Fixtures under test/fixtures/ record what each page looked like when the
 * parser was written (2026-09-10).
 */
import { money, validRates, type Rates } from "./prices.ts";

export const DEEPSEEK_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
export const OPENAI_URL = "https://developers.openai.com/api/docs/pricing";
export const ANTHROPIC_URL = "https://docs.anthropic.com/en/docs/about-claude/pricing";

// ---------------------------------------------------------------- HTML helpers

/** Tags and entities out, whitespace collapsed. */
export function plainText(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * A table as a grid with rowspan/colspan expanded, so a price stays attached to
 * its model column and its category row. Footnote markers like "(3)" are dropped.
 */
export function htmlTable(html: string): string[][] {
	const grid: string[][] = [];
	const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
	rows.forEach((row, y) => {
		grid[y] ??= [];
		let x = 0;
		for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
			while (grid[y][x] !== undefined) x++;
			const span = (name: string) => Math.min(30, Math.max(1, Number(cell[1].match(new RegExp(`${name}=["']?(\\d+)`, "i"))?.[1] ?? 1)));
			const h = span("rowspan");
			const w = span("colspan");
			const text = plainText(cell[2]).replace(/\s*\(\d+\)\s*$/, "");
			for (let dy = 0; dy < h; dy++) {
				grid[y + dy] ??= [];
				for (let dx = 0; dx < w; dx++) grid[y + dy][x + dx] ??= text;
			}
			x += w;
		}
	});
	return grid;
}

// ---------------------------------------------------------------- DeepSeek

export type BandName = "peak" | "off-peak";
export interface Band {
	peak: Rates;
	offPeak: Rates;
}
export interface Schedule {
	/** UTC weekdays (0 = Sunday) on which peak windows apply. */
	days: number[];
	/** [startMinute, endMinute) in UTC. */
	windows: Array<[number, number]>;
}
export interface DeepSeekPrices {
	/** Keyed by the id the page lists. */
	models: Record<string, Band>;
	schedule: Schedule;
}

/**
 * Catalogue ids the page no longer lists but still bills at a listed id's price.
 * Footnote (1) of the page on 2026-09-10: "The legacy names deepseek-v4-flash and
 * deepseek-v4-flash-vision-exp are still accepted … billed at the Flash price."
 */
export const DEEPSEEK_ALIASES: Record<string, string> = {
	"deepseek-v4-flash": "deepseek-flash",
	"deepseek-v4-flash-vision-exp": "deepseek-flash",
};

function parseSchedule(text: string): Schedule | undefined {
	const m = text.match(/Peak hours are (.+?) UTC, Monday through Friday/i);
	if (!m) return undefined;
	const windows: Array<[number, number]> = [];
	for (const part of m[1].split(/\s+and\s+|,\s*/)) {
		const w = part.trim().match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/);
		if (!w) return undefined;
		const start = Number(w[1]) * 60 + Number(w[2]);
		const end = Number(w[3]) * 60 + Number(w[4]);
		if (Number(w[2]) >= 60 || Number(w[4]) >= 60 || start >= end || end > 1440) return undefined;
		windows.push([start, end]);
	}
	return windows.length ? { days: [1, 2, 3, 4, 5], windows } : undefined;
}

/** The pricing table (cache hit / cache miss / output, peak and off-peak) plus the UTC peak schedule. */
export function parseDeepSeek(html: string): DeepSeekPrices | undefined {
	try {
		const table = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]).find((t) => /CACHE HIT/i.test(t) && /deepseek-/i.test(t));
		if (!table) return undefined;
		const rows = htmlTable(table);
		const header = rows.find((r) => r[0] === "MODEL");
		if (!header) return undefined;
		const models: Record<string, Band> = {};
		for (let column = 0; column < header.length; column++) {
			const id = header[column];
			if (!/^deepseek-[a-z0-9.-]+$/.test(id) || models[id]) continue;
			const cell = (category: RegExp, period: string): number | undefined => {
				const hits = rows.filter((r) => r.includes(period) && r.some((c) => category.test(c)));
				return hits.length === 1 ? money(hits[0][column]) : undefined;
			};
			const rates = (period: string): Rates | undefined => {
				const r = { input: cell(/CACHE MISS/, period), cacheRead: cell(/CACHE HIT/, period), output: cell(/OUTPUT TOKENS/, period), cacheWrite: 0 };
				return validRates(r) ? r : undefined;
			};
			const peak = rates("PEAK");
			const offPeak = rates("OFF-PEAK");
			if (!peak || !offPeak) return undefined;
			models[id] = { peak, offPeak };
		}
		const schedule = parseSchedule(plainText(html));
		if (!schedule || Object.keys(models).length === 0) return undefined;
		return { models, schedule };
	} catch {
		return undefined;
	}
}

export function currentBand(schedule: Schedule, now = new Date()): BandName {
	const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
	const peak = schedule.days.includes(now.getUTCDay()) && schedule.windows.some(([a, b]) => minute >= a && minute < b);
	return peak ? "peak" : "off-peak";
}

export function bandRates(band: Band, name: BandName): Rates {
	return { ...(name === "peak" ? band.peak : band.offPeak) };
}

// ---------------------------------------------------------------- OpenAI

export interface OpenAIPrice {
	rates: Rates;
	/** Long-context rates when the row publishes them. */
	long?: Rates;
	/** Tokens above which `long` applies, when the row says so ("(<272K context length)"). */
	threshold?: number;
}

const OPENAI_COLUMNS = [
	"Model",
	"Short context input",
	"Short context cached input",
	"Short context cache writes",
	"Short context output",
	"Long context input",
	"Long context cached input",
	"Long context cache writes",
	"Long context output",
];

function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());
}

function pickRates(row: string[], i: number): Rates | undefined {
	const r = { input: money(row[i]), cacheRead: money(row[i + 1], true), cacheWrite: money(row[i + 2], true), output: money(row[i + 3]) };
	return validRates(r) ? r : undefined;
}

function parseOpenAITable(section: string): Array<[string, OpenAIPrice]> {
	const rows = section
		.split("\n")
		.filter((l) => l.trim().startsWith("|"))
		.map(cells);
	if (rows.length < 2 || rows[0].length !== OPENAI_COLUMNS.length) return [];
	if (rows[0].some((c, i) => c.toLowerCase() !== OPENAI_COLUMNS[i].toLowerCase())) return [];
	const out: Array<[string, OpenAIPrice]> = [];
	for (const row of rows.slice(1)) {
		if (row.length !== OPENAI_COLUMNS.length) continue;
		const id = row[0].match(/^([a-z0-9][a-z0-9.-]*)(?:\s*\(<\s*(\d+)K context length\))?$/i);
		if (!id) continue;
		const rates = pickRates(row, 1);
		if (!rates) continue;
		const price: OpenAIPrice = { rates };
		const long = pickRates(row, 5);
		if (long) {
			price.long = long;
			if (id[2]) price.threshold = Number(id[2]) * 1000;
		}
		out.push([id[1].toLowerCase(), price]);
	}
	return out;
}

/**
 * The Standard table (input, cached input, cache writes, output; long-context
 * columns when present), plus rows of the Grouped tables with the same columns
 * (the Codex-only models live there). Batch, Flex and Fast tables share the
 * header and are never read. First occurrence wins, so Standard beats Grouped.
 */
export function parseOpenAI(markdown: string): Record<string, OpenAIPrice> | undefined {
	const sections = markdown.replace(/\r\n?/g, "\n").split(/\n(?=###\s)/);
	const standard = sections.filter((s) => /^###\s+Standard pricing data/i.test(s));
	if (standard.length === 0) return undefined;
	const grouped = sections.filter((s) => /^###\s+Grouped Pricing Table data/i.test(s));
	const models: Record<string, OpenAIPrice> = {};
	for (const section of [...standard, ...grouped]) for (const [id, price] of parseOpenAITable(section)) models[id] ??= price;
	return Object.keys(models).length ? models : undefined;
}

// ---------------------------------------------------------------- Anthropic

/** "Claude Opus 4.7 ([retired…](…))" → "claude-opus-4-7"; "Claude Sonnet 5" → "claude-sonnet-5". */
export function anthropicSlug(name: string): string | undefined {
	const m = name.trim().match(/^Claude\s+([A-Za-z]+)\s+(\d+)(?:\.(\d+))?(?![\d.])/);
	if (!m) return undefined;
	return `claude-${m[1].toLowerCase()}-${m[2]}${m[3] !== undefined ? `-${m[3]}` : ""}`;
}

/** Does a catalogue id name the page's model? Exact, dated (-YYYYMMDD), or the legacy "claude-3-5-haiku" order. */
export function anthropicIdMatches(slug: string, id: string): boolean {
	const m = slug.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
	if (!m) return false;
	const legacy = `claude-${m[2]}${m[3] !== undefined ? `-${m[3]}` : ""}-${m[1]}`;
	return [slug, legacy].some((base) => id === base || new RegExp(`^${base}-\\d{8}$`).test(id));
}

/** The "Model pricing" table: base input, 5m cache write, cache hit, output. Keyed by slug. */
export function parseAnthropic(markdown: string): Record<string, Rates> | undefined {
	const text = markdown.replace(/\r\n?/g, "\n");
	const start = text.search(/^##\s+Model pricing\s*$/m);
	if (start < 0) return undefined;
	const section = text.slice(start).split(/\n(?=##\s)/)[0];
	const rows = section
		.split("\n")
		.filter((l) => l.trim().startsWith("|"))
		.map(cells);
	if (rows.length < 2) return undefined;
	const header = rows[0].map((c) => c.toLowerCase());
	const col = (re: RegExp) => header.findIndex((c) => re.test(c));
	const idx = { input: col(/base input/), write: col(/5m cache write/), read: col(/cache hits/), output: col(/^output/) };
	if (Object.values(idx).some((i) => i < 0)) return undefined;
	const out: Record<string, Rates> = {};
	for (const row of rows.slice(1)) {
		const slug = anthropicSlug(row[0] ?? "");
		if (!slug || out[slug]) continue;
		const r = { input: money(row[idx.input]), cacheWrite: money(row[idx.write]), cacheRead: money(row[idx.read]), output: money(row[idx.output]) };
		if (validRates(r)) out[slug] = r;
	}
	return Object.keys(out).length ? out : undefined;
}
