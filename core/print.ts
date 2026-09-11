/**
 * Command output in the transcript, drawn in the tool frame.
 *
 * `ctx.ui.notify` paints one dim line and replaces the previous status line,
 * so a multi-line report there loses its colours and its predecessor. A custom
 * session entry with a registered renderer is persistent, themed at render
 * time, replays on /resume, and never reaches the model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Frame, type FrameState } from "./frame.ts";

export const FRAME_ENTRY = "toolkit-frame";

export interface FrameEntryData {
	title: string;
	head: string[];
	lines: string[];
	state: FrameState;
	/** Collapsed frames show 6 lines; expand with the tools key. Default: expanded. */
	collapsed?: boolean;
}

let registered = new WeakSet<object>();

/** Register the renderer once per ExtensionAPI instance. */
export function registerFramePrinter(pi: ExtensionAPI): void {
	if (registered.has(pi as object)) return;
	registered.add(pi as object);
	pi.registerEntryRenderer<FrameEntryData>(FRAME_ENTRY, (entry, options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return new Frame(data.title, data.head, { lines: data.lines, expanded: options.expanded || !data.collapsed }, data.state, theme);
	});
}

/** Append a framed report to the transcript (display only). */
export function printFrame(pi: ExtensionAPI, title: string, head: string[], lines: string[], state: FrameState = "ok", collapsed = false): void {
	try {
		pi.appendEntry(FRAME_ENTRY, { title, head, lines, state, collapsed } satisfies FrameEntryData);
	} catch {
		// No session yet (fresh cwd before the first message): fall back to a notice.
	}
}

/** Reset for tests that create several fake hosts. */
export function resetFramePrinter(): void {
	registered = new WeakSet<object>();
}
