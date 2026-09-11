/** Summed token usage across a child's assistant messages. pi-free. */

/**
 * Custom session entry (`pi.appendEntry`) holding one finished child's usage,
 * booked the moment the child ends — inline, detached, failed or cancelled
 * alike — so the footer's session total includes it. A tool result that also
 * carries that usage (for pi's own session stats) sets `details.spendBooked`
 * and the footer skips it.
 */
export const SPEND_ENTRY = "toolkit-spend";

export interface SpendEntry {
	tool: string;
	role: string;
	model: string;
	usage: UsageSum;
}

export interface UsageSum {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export function emptyUsage(): UsageSum {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Input + output + cache tokens of one usage record (what the caps count). */
export function usageTokens(usage: unknown): number {
	const u = (usage ?? {}) as Record<string, unknown>;
	return num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
}

/** Whether an assistant message asked for tools. One that did not is the final report, which the caps leave alone. */
export function callsTools(message: { stopReason?: unknown; content?: unknown }): boolean {
	if (message.stopReason === "toolUse") return true;
	return Array.isArray(message.content) && message.content.some((c) => (c as { type?: unknown } | null)?.type === "toolCall");
}

export function addUsage(sum: UsageSum, usage: unknown): UsageSum {
	if (!usage || typeof usage !== "object") return sum;
	const u = usage as Record<string, unknown>;
	sum.input += num(u.input);
	sum.output += num(u.output);
	sum.cacheRead += num(u.cacheRead);
	sum.cacheWrite += num(u.cacheWrite);
	sum.totalTokens = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
	const c = (u.cost ?? {}) as Record<string, unknown>;
	sum.cost.input += num(c.input);
	sum.cost.output += num(c.output);
	sum.cost.cacheRead += num(c.cacheRead);
	sum.cost.cacheWrite += num(c.cacheWrite);
	sum.cost.total += num(c.total);
	return sum;
}
