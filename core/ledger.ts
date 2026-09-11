/**
 * Session-local savings ledger. Modules report bytes they removed from what the
 * model would otherwise re-read on every request; `/toolkit stats` prints it.
 *
 * Bytes, not dollars: a byte of tool output is re-sent on every later request,
 * so its real cost depends on how long the session runs. Tokens are estimated
 * as bytes / 4.
 */
export interface LedgerRow {
	before: number;
	after: number;
	count: number;
}

export class Ledger {
	private rows = new Map<string, LedgerRow>();

	add(module: string, before: number, after: number): void {
		const row = this.rows.get(module) ?? { before: 0, after: 0, count: 0 };
		row.before += before;
		row.after += after;
		row.count += 1;
		this.rows.set(module, row);
	}

	entries(): Array<[string, LedgerRow]> {
		return [...this.rows.entries()].sort((a, b) => b[1].before - b[1].after - (a[1].before - a[1].after));
	}

	reset(): void {
		this.rows.clear();
	}

	/** Plain-text report, one line per module. */
	report(): string[] {
		const lines: string[] = [];
		let totalSaved = 0;
		for (const [module, row] of this.entries()) {
			const saved = row.before - row.after;
			totalSaved += saved;
			const pct = row.before > 0 ? Math.round((saved / row.before) * 100) : 0;
			lines.push(`${module.padEnd(14)} ${String(row.count).padStart(4)}×  ${fmtBytes(row.before).padStart(8)} → ${fmtBytes(row.after).padStart(8)}  (-${pct}%, ~${fmtTokens(saved)} tokens)`);
		}
		if (lines.length === 0) lines.push("nothing recorded yet this session");
		else lines.push(`total saved ≈ ${fmtBytes(totalSaved)} (~${fmtTokens(totalSaved)} tokens per request)`);
		return lines;
	}
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export function fmtTokens(bytes: number): string {
	const tokens = Math.round(bytes / 4);
	if (tokens < 1000) return String(tokens);
	return `${(tokens / 1000).toFixed(1)}k`;
}
