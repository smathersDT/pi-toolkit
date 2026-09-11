/**
 * thinking-hud — a spinner and a request clock while the model works, one line
 * in the transcript when the request settles.
 *
 *   ⠹ Thinking… 12s   (esc to interrupt)                          while it runs
 *   ✻ Worked for 41s                                  afterwards
 *
 * The clock is the whole request — agent_start to agent_settled, across every
 * model call, tool run, retry and compaction — and only the phase label changes.
 * Usage is summed over every assistant message and every toolResult (a subagent
 * fleet bills on the toolResult), so the settle line prices the whole request.
 *
 * Nothing reaches the model: the clock is pi's working row, the report a custom
 * entry. The reasoning text itself is hidden by pi's own `hideThinkingBlock`
 * setting, which this module switches on (config `hideThinkingText`).
 */
import { keyText } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { writeJsonAtomic } from "../../core/paths.ts";
import { patchHiddenThinkingBlankLines } from "./patch.ts";
import { type Phase, phaseLabel, type RequestStats, settleLines, type SpinnerName, SPINNERS, workingLine } from "./render.ts";

/** The custom entry appended once per request at settle. */
export const ENTRY_TYPE = "toolkit-hud";

/** The clock shows whole seconds, so once a second is enough. */
const TICK_MS = 1000;
const SPIN_MS = 80;

const DEFAULTS: { hideThinkingText: boolean; spinner: SpinnerName } = {
	hideThinkingText: true,
	spinner: "braille",
};

/** Wall clock, replaceable by tests. */
export const clock = { now: (): number => Date.now() };

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;

function interruptKey(): string {
	try {
		return keyText("app.interrupt") || "";
	} catch {
		return "esc";
	}
}

/**
 * Flip pi's `hideThinkingBlock` on in <agent-dir>/settings.json, keeping every
 * other key. A file that does not parse is left alone: overwriting a user's
 * settings with a guess is worse than a visible thinking block.
 */
function ensureHiddenThinking(ctx: ExtensionContext, kit: Toolkit, notified: { done: boolean }): void {
	const path = join(kit.paths.agentDir, "settings.json");
	let data: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf8");
			const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
			data = parsed as Record<string, unknown>;
		} catch (error) {
			kit.log("thinking-hud", `settings.json unreadable, leaving it alone: ${String(error)}`);
			return;
		}
	}
	if (data.hideThinkingBlock === true) return;
	data.hideThinkingBlock = true;
	writeJsonAtomic(path, data);
	if (!notified.done) {
		notified.done = true;
		ctx.ui.notify("thinking text hidden from next start (settings.json hideThinkingBlock)", "info");
	}
}

const module: ToolkitModule = {
	id: "thinking-hud",
	label: "Thinking HUD",
	description: "Spinner and request clock while working; one settle line per request",
	default: true,
	order: 75,
	child: "never",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const cfg = kit.config("thinking-hud", DEFAULTS);
		if (cfg.hideThinkingText && !patchHiddenThinkingBlankLines()) kit.log("thinking-hud", "blank-line patch not applied (pi internals changed)");
		const frames = SPINNERS[cfg.spinner] ?? SPINNERS.braille;
		const notified = { done: false };

		/** Epoch ms the request started, 0 when none is running. */
		let startedAt = 0;
		let thinkingMs = 0;
		/** Epoch ms the open thinking block started, 0 when none is open. */
		let thinkingOpenedAt = 0;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let costUsd = 0;
		let hadThinking = false;
		let stopReason = "stop";
		let phase: Phase = "working";
		let streamingTool: string | undefined;
		/** Tools running right now, by call id — parallel execution means more than one. */
		const running = new Map<string, string>();
		let ticker: ReturnType<typeof setInterval> | undefined;
		/** Resolved once per request rather than once a second. */
		let hint = "";

		const tick = (ctx: ExtensionContext): void => {
			if (startedAt === 0) return;
			ctx.ui.setWorkingMessage(workingLine(phaseLabel(phase, streamingTool, [...running.values()]), clock.now() - startedAt, hint));
		};

		/** Idempotent: a request can span several agent runs (retry, compaction, follow-up). */
		const begin = (ctx: ExtensionContext): void => {
			if (startedAt !== 0 || ctx.mode !== "tui") return;
			startedAt = clock.now();
			thinkingMs = 0;
			thinkingOpenedAt = 0;
			input = 0;
			output = 0;
			cacheRead = 0;
			cacheWrite = 0;
			costUsd = 0;
			hadThinking = false;
			stopReason = "stop";
			phase = "working";
			streamingTool = undefined;
			running.clear();
			hint = interruptKey();
			tick(ctx);
			ticker = setInterval(() => tick(ctx), TICK_MS);
			ticker.unref?.();
		};

		/** Stops the clock and hands the row back to pi. Safe to call twice. */
		const end = (ctx: ExtensionContext): void => {
			if (ticker) {
				clearInterval(ticker);
				ticker = undefined;
			}
			if (startedAt !== 0 && ctx.mode === "tui") ctx.ui.setWorkingMessage();
			startedAt = 0;
			running.clear();
		};

		const closeThinking = (): void => {
			if (thinkingOpenedAt === 0) return;
			thinkingMs += clock.now() - thinkingOpenedAt;
			thinkingOpenedAt = 0;
		};

		const addUsage = (usage: Usage): void => {
			input += usage?.input ?? 0;
			output += usage?.output ?? 0;
			cacheRead += usage?.cacheRead ?? 0;
			cacheWrite += usage?.cacheWrite ?? 0;
			costUsd += usage?.cost?.total ?? 0;
		};

		pi.on("session_start", (_event, ctx) => {
			end(ctx);
			if (ctx.mode !== "tui") return;
			try {
				// The static "Thinking..." placeholder says nothing the live HUD does not.
				ctx.ui.setHiddenThinkingLabel("");
				ctx.ui.setWorkingIndicator({ frames: frames.map((f) => ctx.ui.theme.fg("accent", f)), intervalMs: SPIN_MS });
				if (cfg.hideThinkingText) ensureHiddenThinking(ctx, kit, notified);
			} catch (error) {
				kit.log("thinking-hud", `session_start: ${String(error)}`);
			}
		});

		// The clock belongs to the request: agent_start starts it, turn_start and
		// message_start are fallbacks that become no-ops once it runs.
		pi.on("agent_start", (_event, ctx) => begin(ctx));
		pi.on("turn_start", (_event, ctx) => {
			begin(ctx);
			streamingTool = undefined;
		});
		pi.on("message_start", (event, ctx) => {
			if (event.message.role === "assistant") begin(ctx);
		});

		pi.on("message_update", (event, ctx) => {
			if (event.message.role !== "assistant" || startedAt === 0) return;
			const stream = event.assistantMessageEvent;
			let changed = true;
			switch (stream.type) {
				case "thinking_start":
					phase = "thinking";
					thinkingOpenedAt = clock.now();
					break;
				case "thinking_end":
					closeThinking();
					changed = false;
					break;
				case "text_start":
					phase = "responding";
					break;
				case "toolcall_start": {
					phase = "calling";
					// The name arrives with the block itself; the event only carries an index.
					const block = stream.partial?.content?.[stream.contentIndex];
					streamingTool = block?.type === "toolCall" ? block.name : undefined;
					break;
				}
				default:
					changed = false;
			}
			if (changed) tick(ctx);
		});

		pi.on("message_end", (event, ctx) => {
			const message = event.message;
			if (message.role === "toolResult") {
				addUsage(message.usage);
				return;
			}
			if (message.role !== "assistant") return;
			// An abort can land mid-block and leave the thinking clock open.
			closeThinking();
			phase = running.size > 0 ? "running" : "working";
			if (message.content.some((b) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0)) {
				hadThinking = true;
			}
			addUsage(message.usage);
			stopReason = message.stopReason ?? "stop";
			tick(ctx);
		});

		pi.on("tool_execution_start", (event, ctx) => {
			running.set(event.toolCallId, event.toolName);
			phase = "running";
			tick(ctx);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			running.delete(event.toolCallId);
			if (running.size === 0 && phase === "running") phase = "working";
			tick(ctx);
		});

		// agent_settled is the one that means pi will not continue on its own.
		pi.on("agent_settled", (_event, ctx) => {
			if (startedAt !== 0 && ctx.mode === "tui") {
				closeThinking();
				const stats: RequestStats = {
					totalMs: clock.now() - startedAt,
					thinkingMs,
					input,
					output,
					cacheRead,
					cacheWrite,
					costUsd,
					stopReason,
					hadThinking,
				};
				try {
					pi.appendEntry(ENTRY_TYPE, stats);
				} catch (error) {
					kit.log("thinking-hud", `appendEntry: ${String(error)}`);
				}
			}
			end(ctx);
		});

		pi.on("session_shutdown", (_event, ctx) => end(ctx));

		pi.registerEntryRenderer<RequestStats>(ENTRY_TYPE, (entry, options, theme) =>
			entry.data ? new Text(settleLines(entry.data, theme, options.expanded).join("\n"), 0, 0) : undefined,
		);
	},
};

export default module;
