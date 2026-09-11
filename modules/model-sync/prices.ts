/**
 * Price shapes and the guards every number passes before it reaches models.json.
 * No pi imports: the parsers and the tests run under bare node.
 */

/** Per-million-token USD rates, in the shape pi's catalogue uses. */
export interface Rates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Tier extends Rates {
	/** The tier applies to the whole request once total input usage exceeds this. */
	inputTokensAbove: number;
}

export interface Cost extends Rates {
	tiers?: Tier[];
}

export const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Nothing we sync costs more than this per million tokens; anything above is a parse error. */
export const MAX_RATE = 1000;

export function saneRate(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_RATE;
}

export function validRates(r: unknown): r is Rates {
	return !!r && typeof r === "object" && RATE_KEYS.every((k) => saneRate((r as Record<string, unknown>)[k]));
}

export function validCost(c: unknown): c is Cost {
	if (!validRates(c)) return false;
	const tiers = (c as Cost).tiers;
	if (tiers === undefined) return true;
	return Array.isArray(tiers) && tiers.every((t) => validRates(t) && Number.isInteger(t.inputTokensAbove) && t.inputTokensAbove > 0);
}

/**
 * "$4.00", "$0.25 / MTok1" (footnote glued to the unit), "$1" → number.
 * "-", "—", "N/A" or empty → 0 when the column is optional, else undefined.
 * Anything else (TBD, "2x input", a bare number) → undefined: never guess.
 */
export function money(text: string | undefined, optional = false): number | undefined {
	const s = (text ?? "").trim();
	if (s === "" || /^(?:-|—|–|N\/A)$/i.test(s)) return optional ? 0 : undefined;
	const m = s.match(/^\$\s*(\d+(?:\.\d+)?)(?:\s*\/\s*M?Tok\w*)?$/i);
	if (!m) return undefined;
	const n = Number(m[1]);
	return saneRate(n) ? n : undefined;
}

function close(a: number | undefined, b: number | undefined): boolean {
	return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9;
}

function tierKey(tiers: Tier[] | undefined): string {
	return JSON.stringify((tiers ?? []).map((t) => [t.inputTokensAbove, t.input, t.output, t.cacheRead, t.cacheWrite]).sort((x, y) => x[0] - y[0]));
}

/** Whether writing `after` over `before` changes what pi bills. Tiers count only when `after` states them. */
export function costMoved(before: Partial<Cost> | undefined, after: Cost): boolean {
	if (!before) return true;
	if (RATE_KEYS.some((k) => !close(before[k], after[k]))) return true;
	return after.tiers !== undefined && tierKey(before.tiers) !== tierKey(after.tiers);
}

/** Which of the four rates differ. */
export function movedRates(before: Partial<Cost> | undefined, after: Cost): Array<(typeof RATE_KEYS)[number]> {
	return RATE_KEYS.filter((k) => !close(before?.[k], after[k]));
}

/** "$4", "$0.075": a rate for display, no trailing zeros. */
export function fmtRate(n: number | undefined): string {
	if (typeof n !== "number" || !Number.isFinite(n)) return "—";
	return `$${Number(n.toFixed(6))}`;
}
