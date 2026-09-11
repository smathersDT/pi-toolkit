/**
 * The transcript rows auto-learn draws — display only, never sent to the model:
 *
 *   ◆ LEARNED · dialtower-back · ~32 tok
 *     - When a grep pattern has parentheses, pass literal:true.
 *
 *   ◆ INJECTED · session start · dialtower-back · 5 lessons · ~210 tok
 *     - …
 *
 * Token counts are estimates (bytes / 4) of what the lessons add to the context.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { COLLAPSED_LINES, type FrameTheme, hintText } from "../../core/frame.ts";
import { estimateTokens, plural } from "../../core/text.ts";

/** Where lessons joined the context. */
export type InjectTrigger = "start" | "prompt" | "turn" | "repo" | "compaction";

export const TRIGGER_LABEL: Record<InjectTrigger, string> = {
	start: "session start",
	prompt: "new prompt",
	turn: "mid-turn",
	repo: "repo seen",
	compaction: "after compaction",
};

export interface RowLesson {
	id: string;
	text: string;
	role: string | null;
}

/** "bitbucket.org/acme/widgets" → "widgets". */
export function shortRepo(label: string): string {
	return label.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || label;
}

const clip = (line: string, width: number): string => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);

/** A bold coloured title, muted meta, and lesson lines wrapped under it. */
export class LessonRow implements Component {
	title: string;
	color: string;
	meta: string[];
	lines: string[];
	expanded: boolean;
	private theme: FrameTheme;

	constructor(title: string, color: string, meta: string[], lines: string[], expanded: boolean, theme: FrameTheme) {
		this.title = title;
		this.color = color;
		this.meta = meta;
		this.lines = lines;
		this.expanded = expanded;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const meta = this.meta.filter(Boolean).join(" · ");
		const out = [clip(`${t.bold(t.fg(this.color, `◆ ${this.title}`))}${meta ? t.fg("muted", ` · ${meta}`) : ""}`, width)];
		const shown = this.expanded ? this.lines : this.lines.slice(0, COLLAPSED_LINES);
		const inner = Math.max(8, width - 4);
		for (const line of shown) {
			wrapTextWithAnsi(line, inner).forEach((part, i) => out.push(clip(`${i === 0 ? "  - " : "    "}${part}`, width)));
		}
		const hint = hintText(t, this.lines.length - shown.length, this.expanded);
		if (hint) out.push(clip(`    ${hint}`, width));
		return out;
	}
}

/** Tokens a lesson adds as one `- text` line of a block. */
export const lessonTokens = (text: string): number => estimateTokens(`- ${text}\n`);

export function learnedRow(data: { kind?: string; repo?: string; lesson?: string }, expanded: boolean, theme: FrameTheme): LessonRow {
	const lesson = data.lesson ?? "";
	const title = data.kind === "updated" ? "LESSON UPDATED" : "LEARNED";
	return new LessonRow(title, "success", [shortRepo(data.repo ?? ""), `~${lessonTokens(lesson)} tok`], [lesson], expanded, theme);
}

export interface InjectedData {
	trigger: InjectTrigger;
	repo: string;
	lessons: RowLesson[];
	/** Estimated tokens of the text the model received. */
	tokens: number;
}

export function injectedRow(data: InjectedData | undefined, expanded: boolean, theme: FrameTheme): LessonRow {
	const lessons = data?.lessons ?? [];
	const roles = [...new Set(lessons.map((l) => l.role).filter((r): r is string => !!r && r !== "main"))];
	const meta = [
		TRIGGER_LABEL[data?.trigger as InjectTrigger] ?? "injected",
		shortRepo(data?.repo ?? ""),
		plural(lessons.length, "lesson"),
		`~${data?.tokens ?? 0} tok`,
		roles.length ? `learned by ${roles.join(", ")}` : "",
	];
	return new LessonRow("INJECTED", "accent", meta, lessons.map((l) => l.text), expanded, theme);
}
