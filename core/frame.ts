/**
 * The boxed tool frame every tool in the toolkit renders with:
 *
 *   ╭─ BASH ──────────
 *   │ git status --porcelain
 *   │
 *   │ M src/index.ts
 *   │ ?? notes.md
 *   │ … +14 lines (ctrl+o to expand)
 *
 * The top rule spans a third of the width and there is no closing border.
 *
 * pi renders a tool row as two slots — `renderCall` (the header) and
 * `renderResult` (the output) — so the frame is split into a top and a bottom
 * component. Both are plain `Component`s (`render(width) => string[]`) so they
 * can also be used for extension command output and custom panels.
 *
 * Nothing here touches the model: it is display-only.
 */
import { keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

/** The theme methods the frame needs; the real pi Theme satisfies this. */
export interface FrameTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export type FrameState = "running" | "ok" | "error";

/** Collapsed frames show at most this many body lines. */
export const COLLAPSED_LINES = 6;

/** Shared state between the call and result slots of one tool row. */
export interface FrameRowState {
	done?: boolean;
	error?: boolean;
	/** Set when a body was rendered, so the header can show the closing state. */
	invalidated?: boolean;
}

function stateColor(state: FrameState): string {
	return state === "error" ? "error" : state === "ok" ? "success" : "warning";
}

function clip(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/** `╭─ NAME ───` spanning a third of the width (never shorter than the label). */
export function topBorder(title: string, state: FrameState, width: number, theme: FrameTheme): string {
	const name = title.toUpperCase().replace(/[^A-Z0-9_ -]/g, "");
	const lead = theme.fg("dim", "╭─ ");
	const label = theme.bold(theme.fg(stateColor(state), name));
	const used = 4 + name.length;
	const rule = Math.max(Math.floor(width / 3), used + 2);
	const fill = theme.fg("dim", ` ${"─".repeat(rule - used)}`);
	return clip(lead + label + fill, width);
}

/** `│ text`, clipped to width. */
export function bodyLine(text: string, width: number, theme: FrameTheme, color = "toolOutput"): string {
	const gutter = theme.fg("dim", "│ ");
	const body = color ? theme.fg(color, text.replace(/\t/g, "  ")) : text;
	return clip(gutter + body, width);
}

export function hintText(theme: FrameTheme, hidden: number, expanded: boolean): string {
	if (expanded || hidden <= 0) return "";
	const hint = safeKeyHint("app.tools.expand", "to expand");
	return theme.fg("muted", `… +${hidden} lines${hint ? ` (${hint})` : ""}`);
}

function safeKeyHint(id: string, description: string): string {
	try {
		return keyHint(id, description);
	} catch {
		return `ctrl+o ${description}`;
	}
}

export interface BodyOptions {
	/** All output lines. */
	lines: string[];
	expanded: boolean;
	/** Show the last lines when collapsed (bash: the verdict is at the end). */
	tail?: boolean;
	/** Override the collapsed line budget. */
	maxLines?: number;
	/** Colour for body lines; "" keeps pre-coloured text as-is. */
	color?: string;
}

/** Choose which lines are visible collapsed, plus the hidden count. */
export function windowLines(lines: string[], expanded: boolean, tail = false, maxLines = COLLAPSED_LINES): { shown: string[]; hidden: number; fromTail: boolean } {
	if (expanded || lines.length <= maxLines) return { shown: lines, hidden: 0, fromTail: false };
	const shown = tail ? lines.slice(-maxLines) : lines.slice(0, maxLines);
	return { shown, hidden: lines.length - maxLines, fromTail: tail };
}

/** Render the body lines with the gutter and the hint. */
export function renderBody(opts: BodyOptions, width: number, theme: FrameTheme): string[] {
	const { shown, hidden, fromTail } = windowLines(opts.lines, opts.expanded, opts.tail, opts.maxLines);
	const out: string[] = [];
	if (fromTail && hidden > 0) out.push(bodyLine(theme.fg("muted", `… ${hidden} earlier lines hidden`), width, theme, ""));
	for (const line of shown) out.push(bodyLine(line, width, theme, opts.color ?? "toolOutput"));
	if (!fromTail) {
		const hint = hintText(theme, hidden, opts.expanded);
		if (hint) out.push(bodyLine(hint, width, theme, ""));
	} else if (!opts.expanded && hidden > 0) {
		const hint = safeKeyHint("app.tools.expand", "to expand");
		if (hint) out.push(bodyLine(theme.fg("muted", `(${hint})`), width, theme, ""));
	}
	return out;
}

/**
 * Header slot: top border + the "head" lines (the command, the path, the query).
 * A blank gutter line follows when a body will be rendered under it.
 * With `summary` set it draws only that one line (a finished, collapsed row);
 * with `hidden` set it draws nothing.
 */
export class FrameTop implements Component {
	title: string;
	head: string[];
	state: FrameState;
	separator: boolean;
	summary: string | undefined;
	hidden = false;
	private theme: FrameTheme;

	constructor(title: string, head: string[], state: FrameState, theme: FrameTheme, separator = true) {
		this.title = title;
		this.head = head;
		this.state = state;
		this.theme = theme;
		this.separator = separator;
	}

	update(title: string, head: string[], state: FrameState, separator = true): this {
		this.title = title;
		this.head = head;
		this.state = state;
		this.separator = separator;
		return this;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.hidden) return [];
		if (this.summary !== undefined) return [clip(this.summary, width)];
		const out = [topBorder(this.title, this.state, width, this.theme)];
		for (const line of this.head) out.push(bodyLine(line, width, this.theme, "accent"));
		if (this.separator) out.push(bodyLine("", width, this.theme, ""));
		return out;
	}
}

/** Result slot: the body lines and the footer; nothing while `hidden` (the header carries a summary). */
export class FrameBottom implements Component {
	body: BodyOptions;
	footer: string[];
	hidden = false;
	private theme: FrameTheme;

	constructor(body: BodyOptions, theme: FrameTheme, footer: string[] = []) {
		this.body = body;
		this.theme = theme;
		this.footer = footer;
	}

	update(body: BodyOptions, footer: string[] = []): this {
		this.body = body;
		this.footer = footer;
		return this;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.hidden) return [];
		const out = renderBody(this.body, width, this.theme);
		for (const line of this.footer) out.push(bodyLine(line, width, this.theme, "muted"));
		return out;
	}
}

/** A whole frame in one component, for command output and panels. */
export class Frame implements Component {
	title: string;
	head: string[];
	body: BodyOptions;
	state: FrameState;
	private theme: FrameTheme;

	constructor(title: string, head: string[], body: BodyOptions, state: FrameState, theme: FrameTheme) {
		this.title = title;
		this.head = head;
		this.body = body;
		this.state = state;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const top = new FrameTop(this.title, this.head, this.state, this.theme, this.body.lines.length > 0).render(width);
		return [...top, ...renderBody(this.body, width, this.theme)];
	}
}

/**
 * The one line a finished, collapsed tool row shrinks to:
 *   ✓ READ src/a.ts:1-40 · 40 lines
 *   ✗ GREP foo( · src · rg: regex parse error
 */
export function summaryLine(title: string, head: string, stats: string[], state: FrameState, theme: FrameTheme): string {
	const failed = state === "error";
	const mark = theme.bold(theme.fg(stateColor(state), `${failed ? "✗" : "✓"} ${title.toUpperCase()}`));
	const parts = [mark];
	if (head) parts.push(theme.fg("accent", head));
	const tail = stats.filter(Boolean).join(" · ");
	if (tail) parts.push(theme.fg(failed ? "error" : "muted", `· ${tail}`));
	return parts.join(" ").replace(/\t/g, "  ");
}

/** Frame lines for plain-string widgets and notifications (no Component needed). */
export function frameLines(title: string, head: string[], lines: string[], state: FrameState, width: number, theme: FrameTheme, expanded = true): string[] {
	return new Frame(title, head, { lines, expanded }, state, theme).render(width);
}

/** Split tool output text into display lines, dropping trailing blanks. */
export function toLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	return lines;
}

/** Text of a tool result's text blocks. */
export function textOf(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	if (!result?.content) return "";
	return result.content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}
