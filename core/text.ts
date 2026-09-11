/**
 * Small text helpers shared by modules. No pi imports, so tests can run them
 * under bare node.
 */

/** Strip ANSI escape sequences (colour, cursor, OSC). */
export function stripAnsi(text: string): string {
	// biome-ignore lint: control characters are the point here
	return text.replace(/\[[0-?]*[ -/]*[@-~]/g, "").replace(/\][^]*(?:|\\)/g, "").replace(/[()][A-Z0-9]/g, "");
}

/** Replay carriage returns: a progress bar redrawn 200 times becomes its final frame. */
export function replayCarriageReturns(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			if (!line.includes("\r")) return line;
			const parts = line.split("\r");
			let out = "";
			for (const part of parts) {
				if (part === "") continue;
				out = part.length >= out.length ? part : part + out.slice(part.length);
			}
			return out;
		})
		.join("\n");
}

/** Collapse trailing spaces and runs of blank lines to one blank line. */
export function tidyWhitespace(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\n+$/, "");
}

/** Runs of identical lines (3 or more) become one line plus `[+N identical lines]`. Lossless. */
export function foldIdenticalLines(text: string, minRun = 3): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const run = j - i;
		if (run >= minRun && lines[i].trim() !== "") {
			out.push(lines[i], `[+${run - 1} identical lines]`);
		} else {
			for (let k = i; k < j; k++) out.push(lines[k]);
		}
		i = j;
	}
	return out.join("\n");
}

/** Rough token estimate. */
export function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The first `maxBytes` of a string, cut on a UTF-8 character boundary rather than a line one. */
export function headBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	// Back off continuation bytes so the last character is not cut in half.
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/** Human duration: 4.2s, 1m 04s, 1h 02m. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rest = s % 60;
	if (m < 60) return `${m}m ${String(rest).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Whole-second clock for a live counter: 12s, 1m 04s. */
export function formatClock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatUsd(usd: number): string {
	if (usd === 0) return "$0";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

export function formatCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function plural(n: number, word: string): string {
	if (n === 1) return `${n} ${word}`;
	const es = /(?:s|x|z|ch|sh)$/.test(word);
	return `${n} ${word}${es ? "es" : "s"}`;
}
