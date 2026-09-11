/**
 * pre-send — write the next prompts while the agent is busy, hand them over
 * one at a time when it is not.
 *
 * `ctrl+q` puts the editor text on a queue instead of sending it. The queue
 * drains first-in-first-out: one prompt, one run, the next when that run has
 * settled. If the agent is idle and the queue is not held, the prompt goes at
 * once. pi's own follow-up key (a message typed while streaming) is taken into
 * the same queue, so there is one list whichever key was reached for.
 *
 * A prompt is sent exactly as enter would have sent it — `pi.sendUserMessage`
 * with template expansion on — so the cached prefix is untouched. A frame above
 * the editor lists what is waiting; `/queue` edits it.
 *
 * Where pi's follow-up key is ctrl+q (Windows, WSL) the shortcut is not
 * registered — pi reserves the key and would report a conflict at startup —
 * and the `input` hook carries the feature on its own.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { frameLines, type FrameTheme } from "../../core/frame.ts";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { PromptQueue, type QueuedImage, type QueuedPrompt, summarize } from "./queue.ts";

export const QUEUE_KEY = "ctrl+q";
const WIDGET_KEY = "toolkit-queue";
/** pi caps a widget at 10 lines; the frame spends three on the top rule, heading and separator. */
export const MAX_ROWS = 6;
/**
 * How long a sent prompt may go unacknowledged before it is treated as refused.
 * pi acknowledges with an `input` event and then `agent_start`; a refusal
 * (compaction in progress, no API key) is silent, so silence is the signal.
 */
export const SEND_GRACE_MS = 8_000;
/** A `/command` runs and returns without a run, so silence there means "done". */
export const COMMAND_GRACE_MS = 1_500;

export interface WidgetState {
	items: readonly QueuedPrompt[];
	inFlight: QueuedPrompt | undefined;
	held: boolean;
	agentBusy: boolean;
	/** The key that releases a held queue from an empty prompt, when it is ours. */
	releaseKey?: string;
}

function rowText(item: QueuedPrompt): string {
	const { line, more } = summarize(item.text);
	const extras: string[] = [];
	if (more > 0) extras.push(`+${more} line${more === 1 ? "" : "s"}`);
	if (item.images?.length) extras.push(`${item.images.length} image${item.images.length === 1 ? "" : "s"}`);
	return extras.length > 0 ? `${line} (${extras.join(", ")})` : line;
}

/**
 * The panel lines, or `[]` when nothing waits. A single prompt in flight with
 * nothing behind it is not shown: the transcript already has it.
 */
export function widgetLines(state: WidgetState, theme: FrameTheme, width: number, maxRows = MAX_ROWS): string[] {
	const waiting = state.items.length;
	if (waiting === 0) return [];
	const noun = waiting === 1 ? "prompt" : "prompts";
	let heading: string;
	if (state.held) heading = `${waiting} ${noun} held · /queue go${state.releaseKey ? ` or ${state.releaseKey} on an empty prompt` : ""} to release`;
	else if (state.inFlight) heading = `sending · ${waiting} waiting`;
	else if (state.agentBusy) heading = `${waiting} ${noun} · sent when the agent is idle`;
	else heading = `${waiting} ${noun}`;
	const rows: string[] = [];
	if (state.inFlight) rows.push(`▶ ${rowText(state.inFlight)}`);
	const budget = Math.max(1, maxRows) - rows.length;
	const overflow = Math.max(0, waiting - budget);
	const visible = overflow > 0 ? Math.max(0, budget - 1) : waiting;
	state.items.slice(0, visible).forEach((item, index) => rows.push(`${String(index + 1).padStart(2)}. ${rowText(item)}`));
	const hidden = waiting - visible;
	if (hidden > 0) rows.push(`    +${hidden} more`);
	return frameLines("queue", [heading], rows, "running", width, theme);
}

/**
 * pi's follow-up key: `ctrl+q` on Windows and WSL, `alt+enter` elsewhere, unless
 * `<agent-dir>/keybindings.json` rebinds it (legacy name `followUp`). Mirrors
 * pi's keybindings.ts, which the package does not export.
 */
export function followUpKeys(agentDir: string, platform: string = process.platform, env: Record<string, string | undefined> = process.env): string[] {
	const windows = platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
	let keys: unknown = windows ? "ctrl+q" : "alt+enter";
	try {
		const user = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8").replace(/^﻿/, "")) as Record<string, unknown> | null;
		const bound = user?.["app.message.followUp"] ?? user?.followUp;
		if (typeof bound === "string" || Array.isArray(bound)) keys = bound;
	} catch {}
	return (Array.isArray(keys) ? keys : [keys]).filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase());
}

/** Wire the queue into a pi host. Exported so tests can reach the queue. */
export function install(pi: ExtensionAPI, kit: Toolkit, options: { followUpKeys?: readonly string[] } = {}): { queue: PromptQueue } {
	const queue = new PromptQueue();
	/** Between `agent_start` and `agent_settled`; wording only — sends consult `ctx.isIdle()`. */
	let agentBusy = false;
	let widgetShown = false;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let shortcutError: string | undefined;
	let shortcutWarned = false;
	/** Set once ctrl+q is registered as ours. */
	let releaseKey: string | undefined;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		try {
			ctx.ui.notify(message, level);
		} catch {}
	};

	// pi pads each widget line by one column on both sides.
	const widgetWidth = (): number => Math.max(20, (process.stdout.columns ?? 80) - 2);

	const syncWidget = (ctx: ExtensionContext): void => {
		try {
			const lines = widgetLines({ items: queue.list(), inFlight: queue.inFlight, held: queue.held, agentBusy, releaseKey }, ctx.ui.theme, widgetWidth());
			if (lines.length === 0) {
				if (widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
				widgetShown = false;
				return;
			}
			ctx.ui.setWidget(WIDGET_KEY, lines);
			widgetShown = true;
		} catch {}
	};

	const stopWatchdog = (): void => {
		if (watchdog) clearTimeout(watchdog);
		watchdog = undefined;
	};

	/** The send never became a run: a `/command` that returned, or a refusal. */
	const reconcileSilentSend = (ctx: ExtensionContext): void => {
		watchdog = undefined;
		const sent = queue.inFlight;
		if (!sent || sent.started) return;
		if (sent.text.startsWith("/")) {
			queue.clearInFlight();
			syncWidget(ctx);
			drain(ctx);
			return;
		}
		queue.requeueInFlight();
		queue.held = true;
		syncWidget(ctx);
		notify(ctx, `queue: pi did not take "${summarize(sent.text).line.slice(0, 40)}" — kept at the head, queue held. /queue go to retry.`, "warning");
	};

	/** Send the head if nothing stands in the way: not held, nothing in flight, agent idle. */
	const drain = (ctx: ExtensionContext): void => {
		if (queue.held || queue.size === 0 || queue.inFlight) return;
		try {
			if (!ctx.isIdle()) return;
		} catch {
			return;
		}
		const item = queue.takeForSend();
		if (!item) return;
		syncWidget(ctx);
		const content: string | Array<TextContent | ImageContent> = item.images?.length ? [{ type: "text", text: item.text }, ...item.images] : item.text;
		try {
			pi.sendUserMessage(content, { expandPromptTemplates: true });
		} catch (error) {
			queue.requeueInFlight();
			queue.held = true;
			syncWidget(ctx);
			notify(ctx, `queue: send failed (${error instanceof Error ? error.message : String(error)}) — queue held. /queue go to retry.`, "error");
			return;
		}
		stopWatchdog();
		watchdog = setTimeout(() => reconcileSilentSend(ctx), item.text.startsWith("/") ? COMMAND_GRACE_MS : SEND_GRACE_MS);
		watchdog.unref?.();
	};

	/** Drain before painting: a prompt that leaves at once must not mount the panel for a tick. */
	const enqueue = (ctx: ExtensionContext, text: string, images?: QueuedImage[]): boolean => {
		const item = queue.push(text, images);
		if (!item) return false;
		drain(ctx);
		syncWidget(ctx);
		return true;
	};

	// When ctrl+q is pi's follow-up key it already lands in the `input` hook below.
	const pisFollowUp = (options.followUpKeys ?? followUpKeys(kit.paths.agentDir)).includes(QUEUE_KEY);
	if (!pisFollowUp) {
		try {
			pi.registerShortcut(QUEUE_KEY, {
				description: "Queue the prompt; queued prompts are sent one at a time when the agent is idle",
				handler: (ctx) => {
					let text = "";
					try {
						text = ctx.ui.getEditorText().trim();
					} catch {
						return;
					}
					if (!text) {
						// The key on an empty prompt releases a held queue.
						if (queue.held) {
							queue.held = false;
							syncWidget(ctx);
							drain(ctx);
						} else if (queue.size > 0) {
							notify(ctx, `queue: ${queue.size} waiting — sent when the agent is idle`);
						}
						return;
					}
					if (enqueue(ctx, text)) {
						try {
							ctx.ui.setEditorText("");
						} catch {}
					}
				},
			});
			releaseKey = QUEUE_KEY;
		} catch (error) {
			shortcutError = error instanceof Error ? error.message : String(error);
			kit.log("pre-send", `shortcut ${QUEUE_KEY} unavailable: ${shortcutError}`);
		}
	}

	/**
	 * pi's follow-up key, pressed while the agent streams, arrives here with
	 * `streamingBehavior: "followUp"`. Steering ("steer") is a different intent
	 * and passes through; so does everything sent while idle, and every message
	 * an extension sends, including ours.
	 */
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			if (queue.inFlight && !queue.inFlight.started) {
				queue.markStarted();
				stopWatchdog();
			}
			return { action: "continue" as const };
		}
		if (event.source !== "interactive" || event.streamingBehavior !== "followUp") return { action: "continue" as const };
		enqueue(ctx, event.text, event.images as QueuedImage[] | undefined);
		return { action: "handled" as const };
	});

	pi.on("agent_start", (_event, ctx) => {
		agentBusy = true;
		if (queue.inFlight && !queue.inFlight.started) {
			queue.markStarted();
			stopWatchdog();
		}
		syncWidget(ctx);
	});

	/** The run is over and pi will not continue on its own: the next prompt's turn. */
	pi.on("agent_settled", (_event, ctx) => {
		agentBusy = false;
		if (queue.inFlight?.started) queue.clearInFlight();
		syncWidget(ctx);
		drain(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		drain(ctx);
	});

	pi.on("session_start", (event, ctx) => {
		agentBusy = false;
		stopWatchdog();
		widgetShown = false;
		if (queue.inFlight) queue.requeueInFlight();
		// Queued prompts are the user's words, not the old session's state, so they
		// are carried over — but not sent into a session they were not written for.
		if (queue.size > 0 && event.reason !== "startup") {
			queue.held = true;
			notify(ctx, `queue: ${queue.size} queued prompt${queue.size === 1 ? "" : "s"} carried over and held — /queue go to send them here, /queue clear to drop them`, "warning");
		}
		if (shortcutError && !shortcutWarned && ctx.hasUI) {
			shortcutWarned = true;
			notify(ctx, `queue: ${QUEUE_KEY} is taken (${shortcutError}); pi's follow-up key still queues while the agent runs`, "warning");
		}
		syncWidget(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWatchdog();
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {}
		widgetShown = false;
	});

	pi.registerCommand("queue", {
		description: "The prompt queue: /queue [hold|go|drop <n>|pop|clear]",
		getArgumentCompletions: (prefix) => {
			const verbs = [
				{ value: "hold", label: "hold", description: "stop sending; keep queueing" },
				{ value: "go", label: "go", description: "release a held queue" },
				{ value: "drop ", label: "drop", description: "remove the prompt at position n" },
				{ value: "pop", label: "pop", description: "take the newest prompt back into the editor" },
				{ value: "clear", label: "clear", description: "empty the queue" },
			];
			const matches = verbs.filter((v) => v.value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const [verb = "list", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			switch (verb) {
				case "hold":
					queue.held = true;
					syncWidget(ctx);
					notify(ctx, `queue held (${queue.size} waiting)`);
					return;
				case "go":
					queue.held = false;
					syncWidget(ctx);
					drain(ctx);
					notify(ctx, queue.size === 0 && !queue.inFlight ? "queue empty" : "queue released");
					return;
				case "drop": {
					const position = Number(rest[0]);
					const gone = queue.drop(position);
					syncWidget(ctx);
					notify(ctx, gone ? `dropped ${position}: ${summarize(gone.text).line.slice(0, 60)}` : `no prompt at position ${rest[0] ?? "?"} (1–${queue.size})`, gone ? "info" : "warning");
					return;
				}
				case "pop": {
					const gone = queue.pop();
					syncWidget(ctx);
					if (!gone) {
						notify(ctx, "queue empty", "warning");
						return;
					}
					try {
						ctx.ui.setEditorText(gone.text);
					} catch {}
					notify(ctx, `back in the editor: ${summarize(gone.text).line.slice(0, 60)}`);
					return;
				}
				case "clear": {
					const gone = queue.clear();
					syncWidget(ctx);
					notify(ctx, `dropped ${gone.length} queued prompt${gone.length === 1 ? "" : "s"}`);
					return;
				}
				case "list": {
					if (queue.size === 0 && !queue.inFlight) {
						notify(ctx, `queue empty — ${QUEUE_KEY} queues the prompt`);
						return;
					}
					const lines: string[] = [];
					if (queue.inFlight) lines.push(`▶ ${queue.inFlight.text}`);
					queue.list().forEach((item, i) => lines.push(`${i + 1}. ${item.text}`));
					kit.print("queue", [queue.held ? `${queue.size} held` : `${queue.size} waiting`], lines, "running");
					return;
				}
				default:
					notify(ctx, "usage: /queue [hold|go|drop <n>|pop|clear]", "warning");
			}
		},
	});

	return { queue };
}

const module: ToolkitModule = {
	id: "pre-send",
	label: "Prompt queue (ctrl+q)",
	description: "ctrl+q queues the prompt; queued prompts are sent one at a time when the agent is idle",
	default: true,
	order: 92,
	child: "never",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		install(pi, kit);
	},
};

export default module;
