/**
 * The footer's text, minus pi: what the session line says, how each fact becomes
 * a chip, how chips wrap and how the two lines are laid out at a width. Pure, so
 * `test/view.test.ts` runs under plain `node`.
 *
 *   $0.042  deepseek-v4-pro · high (shift+tab) · $0.28/$0.42/$0.028  ctx 31k/1M 3%     balance $11.09
 *   bg 1 job 2m  agents 2 running
 */
import { plural, stripAnsi } from "../../core/text.ts";

export interface ThemeLike {
	fg(color: any, text: string): string;
	bold(text: string): string;
}

export type Tone = "on" | "off" | "info" | "warn" | "error";

export interface Chip {
	label: string;
	value: string;
	tone: Tone;
}

/** pi's own colour for each thinking level, so the footer agrees with the thinking block. */
export const LEVEL_COLOR: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** Session total: three decimals under a dollar, two above. */
export function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0";
	return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** `$5`, `$0.5`, `$0.02` — a per-1M rate with no trailing zeros to read past. */
export function formatRate(usd: number): string {
	return `$${Number(usd.toFixed(3))}`;
}

/**
 * `$5/$25/$0.5` — input, output, cached read per 1M tokens. Three numbers, not
 * four: `cacheWrite` is derived from `input` everywhere but Anthropic. A model
 * whose every rate is zero (a local endpoint) returns null: free is worth no width.
 */
export function formatRates(cost: { input?: number; output?: number; cacheRead?: number } | undefined): string | null {
	const rates = [cost?.input, cost?.output, cost?.cacheRead];
	if (rates.every((r) => typeof r !== "number" || r <= 0)) return null;
	return rates.map((r) => formatRate(typeof r === "number" ? r : 0)).join("/");
}

/** `950`, `3k`, `200k`, `1M`. */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}k`;
	return String(Math.max(0, Math.round(n)));
}

/** `12s`, `2m`, `1h 05m` — the age of a background job, in the unit you would act on. */
export function shortAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface SessionFacts {
	costUsd: number;
	modelId?: string;
	reasoning?: boolean;
	thinking?: string;
	/** The key that cycles the thinking level, e.g. `shift+tab`; omitted, no hint. */
	thinkingKey?: string;
	/** What the model in use bills, per 1M tokens; omitted or all-zero, no rates. */
	cost?: { input?: number; output?: number; cacheRead?: number };
}

/** `$0.042  deepseek-v4-pro · high (shift+tab) · $5/$25/$0.5` — who is answering and what they cost. */
export function sessionLine(f: SessionFacts, theme: ThemeLike): string {
	let model = theme.fg("accent", f.modelId ?? "no model");
	if (f.reasoning) {
		const level = f.thinking ?? "off";
		model += `${theme.fg("dim", " · ")}${theme.fg(LEVEL_COLOR[level] ?? "text", level)}`;
		if (f.thinkingKey) model += theme.fg("dim", ` (${f.thinkingKey})`);
	}
	const rates = formatRates(f.cost);
	if (rates) model += theme.fg("dim", ` · ${rates}`);
	return `${theme.fg("success", formatCost(f.costUsd))}  ${model}`;
}

/** The slice of pi's ContextUsage the chip reads. */
export interface ContextFacts {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * `ctx 31k/1M 3%` — text under 60%, warning under 85%, error from there. Tokens
 * are unknown right after a compaction; the chip then says `?` rather than `0`.
 */
export function contextChip(usage: ContextFacts | undefined): Chip | null {
	if (!usage || !(usage.contextWindow > 0)) return null;
	const used = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	const percent = usage.percent === null ? undefined : Math.max(0, Math.round(usage.percent));
	const value = `${used}/${formatTokens(usage.contextWindow)}${percent === undefined ? "" : ` ${percent}%`}`;
	const tone: Tone = percent === undefined || percent < 60 ? "info" : percent < 85 ? "warn" : "error";
	return { label: "ctx", value, tone };
}

/** `bg 2 jobs 3m` — running background jobs and the age of the oldest; nothing when idle. */
export function bgChip(jobs: ReadonlyArray<{ startedAt: number }>, now: number): Chip | null {
	if (jobs.length === 0) return null;
	const oldest = Math.min(...jobs.map((j) => j.startedAt));
	return { label: "bg", value: `${plural(jobs.length, "job")} ${shortAge(now - oldest)}`, tone: "info" };
}

/**
 * `agents 2 running` — from the `subagent` extension status, when some extension
 * sets one. The first integer in the text is the count; `0` hides the chip; text
 * with no number is shown as is. The toolkit's own subagent module publishes no
 * status yet, so this chip is absent until one does.
 */
export function agentsChip(status: string | undefined): Chip | null {
	if (status === undefined) return null;
	const text = valueOf("subagent", status, "agents:");
	const plain = stripAnsi(text);
	const m = /\d+/.exec(plain);
	if (!m) return plain === "" ? null : { label: "agents", value: text, tone: "info" };
	const n = Number(m[0]);
	if (n === 0) return null;
	return { label: "agents", value: `${n} running`, tone: "info" };
}

/** Statuses the footer's own chips already cover (or deliberately omits), so they are not shown. */
export const HIDDEN_STATUS_KEYS: readonly string[] = ["subagent", "background", "permissions", "learn"];

/** Drop a `key: ` prefix an extension put on its own status so the label is not said twice. */
export function valueOf(key: string, text: string, ...prefixes: string[]): string {
	let v = text.trim();
	for (const p of [`${key}:`, ...prefixes]) {
		if (stripAnsi(v).toLowerCase().startsWith(p.toLowerCase())) {
			// Strip on the plain text but keep any colour the extension applied to the rest.
			const plainHead = stripAnsi(v).slice(0, p.length);
			const idx = v.indexOf(plainHead);
			v = (idx >= 0 ? v.slice(idx + plainHead.length) : v).trim();
			break;
		}
	}
	return v;
}

/** One `key value` chip per extension status, in the order pi holds them; `off` reads dim. */
export function statusChips(statuses: ReadonlyMap<string, string>, hidden: readonly string[] = HIDDEN_STATUS_KEYS): Chip[] {
	const chips: Chip[] = [];
	for (const [key, text] of statuses) {
		if (hidden.includes(key)) continue;
		const value = valueOf(key, text);
		if (stripAnsi(value) === "") continue;
		chips.push({ label: key, value, tone: stripAnsi(value) === "off" ? "off" : "info" });
	}
	return chips;
}

const TONE_COLOR: Record<Tone, string> = { on: "success", off: "dim", info: "text", warn: "warning", error: "error" };

export function paintChip(chip: Chip, theme: ThemeLike): string {
	const label = theme.fg(chip.tone === "off" ? "dim" : "muted", chip.label);
	return `${label} ${theme.fg(TONE_COLOR[chip.tone], chip.value)}`;
}

/** The gap between two pieces on one line — the same one `wrapChips` puts between chips. */
const GAP = 2;

/** `left` with `right` two spaces after it; null when the two cannot share a line. */
export function append(left: string, right: string, width: number, visibleWidth: (s: string) => number): string | null {
	if (visibleWidth(left) + GAP + visibleWidth(right) > width) return null;
	return left ? `${left}${" ".repeat(GAP)}${right}` : right;
}

/** `left` with `right` flush against the width; null when the two cannot share a line. */
export function rightJustify(left: string, right: string, width: number, visibleWidth: (s: string) => number): string | null {
	const pad = width - visibleWidth(left) - visibleWidth(right);
	if (pad < GAP) return null;
	return `${left}${" ".repeat(pad)}${right}`;
}

/** Greedy wrap of painted chips into lines no wider than `width`, two spaces apart. */
export function wrapChips(painted: string[], width: number, visibleWidth: (s: string) => number): string[] {
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	for (const chip of painted) {
		const w = visibleWidth(chip);
		if (line && lineWidth + GAP + w > width) {
			lines.push(line);
			line = chip;
			lineWidth = w;
		} else {
			line = line ? `${line}${" ".repeat(GAP)}${chip}` : chip;
			lineWidth = line === chip ? w : lineWidth + GAP + w;
		}
	}
	if (line) lines.push(line);
	return lines;
}

/** Painted pieces, ready to be laid out. */
export interface FooterParts {
	session: string;
	/** The context chip, after the session facts. */
	context?: string;
	/** The account chip, flush right on line one when it fits, else a chip on line two. */
	account?: string;
	/** Line-two chips in order. */
	chips: string[];
}

/**
 * Two lines (more when chips wrap), none wider than `width`. The context chip
 * and then the account fall back to line two when line one has no room; the
 * final cut is `truncate` so nothing ever wraps in the terminal.
 */
export function layoutFooter(
	parts: FooterParts,
	width: number,
	visibleWidth: (s: string) => number,
	truncate: (s: string, width: number) => string,
): string[] {
	const chips = [...parts.chips];
	let first = parts.session;
	if (parts.context) {
		const joined = append(first, parts.context, width, visibleWidth);
		if (joined) first = joined;
		else chips.unshift(parts.context);
	}
	if (parts.account) {
		const joined = rightJustify(first, parts.account, width, visibleWidth);
		if (joined) first = joined;
		else chips.push(parts.account);
	}
	const lines = [first, ...wrapChips(chips, width, visibleWidth)];
	// A fixed height: pi's transcript area is sized by the footer, and a footer that
	// grows and shrinks with the chips makes the editor jump.
	if (lines.length < 2) lines.push("");
	return lines.map((line) => (visibleWidth(line) > width ? truncate(line, width) : line));
}
