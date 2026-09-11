/**
 * The HUD's text: the phase label on pi's working row while a request runs,
 * and the one settle line the request leaves in the transcript afterwards.
 * No pi imports and no live state, so every shape can be tested under bare node.
 */
import { formatClock, formatDuration } from "../../core/text.ts";

/** The theme methods the HUD needs; pi's Theme satisfies this. */
export interface HudTheme {
	fg(color: string, text: string): string;
}

/** Everything the settle line needs, flattened so rendering never touches live state. */
export interface RequestStats {
	/** Wall clock from the request starting to agent_settled. */
	totalMs: number;
	/** Time inside thinking blocks, summed over every model call of the request. */
	thinkingMs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	/** Stop reason of the last model call: stop, toolUse, length, aborted, error … */
	stopReason: string;
	/** Whether any assistant message of the request carried a thinking block. */
	hadThinking: boolean;
}

export type Phase = "working" | "thinking" | "responding" | "calling" | "running";
export type SpinnerName = "braille" | "dots";
export type Tone = "accent" | "warning" | "error";

/** Spinner frames; the caller colours them (pi renders custom frames verbatim). */
export const SPINNERS: Record<SpinnerName, string[]> = {
	braille: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	dots: ["·", "•", "●", "•"],
};

/** The glyph the settle line starts with. */
export const DONE_GLYPH = "✻";

/** Thinking / Responding / Calling <tool> / Running <tool> / Running N tools / Working. */
export function phaseLabel(phase: Phase, streamingTool: string | undefined, running: string[]): string {
	switch (phase) {
		case "thinking":
			return "Thinking";
		case "responding":
			return "Responding";
		case "calling":
			return streamingTool ? `Calling ${streamingTool}` : "Calling tool";
		case "running":
			if (running.length === 0) return "Working";
			return running.length === 1 ? `Running ${running[0]}` : `Running ${running.length} tools`;
		default:
			return "Working";
	}
}

/** `Thinking… 12s   (esc to interrupt)` — the working row while a request runs. */
export function workingLine(label: string, elapsedMs: number, interruptKey: string): string {
	const hint = interruptKey ? `   (${interruptKey} to interrupt)` : "";
	return `${label}… ${formatClock(elapsedMs)}${hint}`;
}

/** How the request ended: the words in front of the duration and their colour. */
export function headline(stats: RequestStats): { verb: string; tone: Tone } {
	switch (stats.stopReason) {
		case "aborted":
			return { verb: "Interrupted after", tone: "warning" };
		case "error":
			return { verb: "Failed after", tone: "error" };
		case "length":
			return { verb: "Hit the output limit after", tone: "warning" };
		default:
			return { verb: "", tone: "accent" };
	}
}

/**
 * The one line a request leaves behind:
 *   ✻ Worked for 41s
 * Bad endings put their own verb on the wall clock ("Interrupted after 4.2s")
 * in the matching colour.
 */
export function settleLine(stats: RequestStats, theme: HudTheme): string {
	const { verb, tone } = headline(stats);
	const label = tone === "accent" ? theme.fg("muted", `Worked for ${formatDuration(stats.totalMs)}`) : theme.fg(tone, `${verb} ${formatDuration(stats.totalMs)}`);
	return `${theme.fg(tone, DONE_GLYPH)} ${label}`;
}

/** The raw counts the one-liner rounds away, for the expanded entry. */
export function settleDetail(stats: RequestStats): string {
	const n = (v: number) => v.toLocaleString("en-US");
	const parts = [`in ${n(stats.input)}`, `out ${n(stats.output)}`];
	if (stats.cacheRead > 0) parts.push(`cache read ${n(stats.cacheRead)}`);
	if (stats.cacheWrite > 0) parts.push(`cache write ${n(stats.cacheWrite)}`);
	parts.push(`stop ${stats.stopReason}`);
	return parts.join(" · ");
}

/** The transcript entry: the settle line, plus the raw counts when expanded. */
export function settleLines(stats: RequestStats, theme: HudTheme, expanded: boolean): string[] {
	const lines = [settleLine(stats, theme)];
	if (expanded) lines.push(theme.fg("dim", `  ${settleDetail(stats)}`));
	return lines;
}
