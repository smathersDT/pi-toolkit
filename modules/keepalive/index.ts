/**
 * keepalive — keep the prompt cache warm through long tool calls, with real
 * requests instead of pings.
 *
 * A provider cache entry (Anthropic 5 min, Copilot 5 min, direct OpenAI
 * GPT-5.6+ 30 min, Codex WebSocket idle close ~300 s) expires while a long
 * tool call blocks, and the next request re-writes the whole prefix at the
 * cache-write price. So `bash` (and `delegate`, via `runWithKeepalive`) return
 * just before the deadline with "[background] job b-3 still running" and keep
 * working as a job. The model calls `wait`, an ordinary request that refreshes
 * the cache for free and blocks until the job finishes or the next deadline.
 *
 *   /keepalive                              policy for the current model + running jobs
 *   /keepalive ttl <provider/model> <secs>  override the TTL (0 disables check-ins)
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FrameBottom, type FrameRowState, FrameTop, textOf, toLines } from "../../core/frame.ts";
import type { AnyToolDefinition, Toolkit, ToolkitModule } from "../../core/kit.ts";
import { formatDuration } from "../../core/text.ts";
import { cacheModelOf, describeJob, KEEPALIVE_DEFAULTS, type KeepaliveConfig, type KeepaliveDetails, keepaliveDeadlineMs, resultText, runWithKeepalive, state, toError } from "./api.ts";
import { DEADLINE, type Job, raceDeadline } from "./jobs.ts";

const FOLLOWUP_HEAD_BYTES = 4096;

interface WaitParams {
	id?: string;
	stop?: boolean;
}

/** What `wait` returns: the job's own content/details/usage, plus `details.keepalive`. */
interface WaitResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown> & { keepalive: KeepaliveDetails };
	usage?: Usage;
}

const module: ToolkitModule = {
	id: "keepalive",
	label: "Cache keepalive",
	description: "Long tool calls yield before the prompt cache expires; collect them with wait",
	default: true,
	order: 50,
	child: "never",
	setup(pi, kit) {
		const cfg = (): KeepaliveConfig => kit.config("keepalive", KEEPALIVE_DEFAULTS);

		pi.on("agent_start", (_event, ctx) => {
			state.requestStartedAt = Date.now();
			state.lastCtx = ctx;
		});
		pi.on("turn_start", (_event, ctx) => {
			state.requestStartedAt = Date.now();
			state.lastCtx = ctx;
		});
		// A job that finished mid-turn and was never collected goes in as a follow-up.
		pi.on("agent_end", (_event, ctx) => {
			state.lastCtx = ctx;
			for (const job of state.registry.pending()) deliverFollowUp(pi, kit, job);
		});
		pi.on("session_shutdown", () => {
			state.registry.cancelAll("session shutdown");
		});
		// A job that finishes while the agent is idle (the model ended the turn without waiting).
		state.registry.onSettle((job) => {
			if (job.delivered || isWaitedOn(job.id)) return;
			try {
				if (state.lastCtx?.isIdle?.()) deliverFollowUp(pi, kit, job);
			} catch (error) {
				kit.log("keepalive", `follow-up failed: ${String(error)}`);
			}
		});

		kit.patchTool("bash", (def) => patchBash(def, kit));

		pi.registerTool({
			name: "wait",
			label: "Wait",
			description: "Collect a [background] job started by a long tool call: blocks until it finishes or the next cache check-in, then returns the tool's own result. stop:true cancels it instead.",
			promptSnippet: "Collect a [background] job (blocks until it finishes)",
			promptGuidelines: ["Use wait to collect a [background] job before giving a final answer; never re-run the command."],
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Job id from the [background] reply; omit to wait for whichever running job finishes first" })),
				stop: Type.Optional(Type.Boolean({ description: "Cancel the job (needs id)" })),
			}),
			renderShell: "self",
			execute: (_toolCallId, params, signal, _onUpdate, ctx) => waitExecute(kit, params as WaitParams, signal, ctx),
			renderCall(args, theme, context) {
				const st = context.state as FrameRowState;
				const a = (args ?? {}) as WaitParams;
				const head = [a.stop ? `stop ${a.id ?? ""}`.trim() : (a.id ?? "any")];
				const frameState = st.done ? (st.error ? "error" : "ok") : "running";
				const top = context.lastComponent instanceof FrameTop ? context.lastComponent : new FrameTop("WAIT", head, frameState, theme);
				return top.update("WAIT", head, frameState, true);
			},
			renderResult(result, options, theme, context) {
				const st = context.state as FrameRowState;
				if (!options.isPartial) {
					st.done = true;
					st.error = context.isError;
					if (!st.invalidated) {
						st.invalidated = true;
						// Deferred: a synchronous invalidate re-enters pi's row update mid-render.
						queueMicrotask(() => {
							try {
								context.invalidate();
							} catch {}
						});
					}
				}
				const lines = toLines(textOf(result));
				const k = (result?.details as { keepalive?: { id?: string; tool?: string; status?: string; durationMs?: number } } | undefined)?.keepalive;
				const footer = k && !options.isPartial && k.status ? [`${k.tool} job ${k.id} · ${k.status}${k.durationMs !== undefined ? ` · ${formatDuration(k.durationMs)}` : ""}`] : [];
				const body = { lines, expanded: options.expanded, maxLines: 6 };
				const bottom = context.lastComponent instanceof FrameBottom ? context.lastComponent : new FrameBottom(body, theme, footer);
				return bottom.update(body, footer);
			},
		});

		pi.registerCommand("keepalive", {
			description: "Cache keepalive: policy for the current model and running jobs (/keepalive ttl <provider/model> <seconds>)",
			handler: async (args, ctx) => {
				const [sub, key, secs] = (args ?? "").trim().split(/\s+/);
				if (sub === "ttl") return setTtl(kit, ctx, key, secs);
				return showStatus(kit, ctx, cfg());
			},
		});
	},
};
export default module;

function isWaitedOn(id: string): boolean {
	return state.waiting.has(id) || state.waiting.has("*");
}

function patchBash(def: AnyToolDefinition, kit: Toolkit): AnyToolDefinition {
	const patched: AnyToolDefinition = {
		...def,
		execute(id, params, signal, onUpdate, ctx) {
			let live = true;
			return runWithKeepalive(kit, ctx, {
				tool: "bash",
				label: String((params as { command?: string })?.command ?? "").replace(/\s+/g, " ").slice(0, 80),
				toolCallId: id,
				signal,
				onDetach: () => {
					live = false;
				},
				work: (s) =>
					def.execute(
						id,
						params,
						s,
						onUpdate
							? (partial) => {
									if (live) onUpdate(partial);
								}
							: undefined,
						ctx,
					),
			}) as ReturnType<AnyToolDefinition["execute"]>;
		},
	};
	if (def.renderResult) {
		const inner = def.renderResult;
		patched.renderResult = (result, options, theme, context) => {
			const k = (result?.details as { keepalive?: { running?: boolean } } | undefined)?.keepalive;
			if (k?.running) return new Text(theme.fg("warning", textOf(result)), 0, 0);
			return inner(result, options, theme, context);
		};
	}
	return patched;
}

async function waitExecute(kit: Toolkit, params: WaitParams, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<WaitResult> {
	const reg = state.registry;
	state.lastCtx = ctx;
	const id = params.id?.trim() || undefined;

	if (params.stop) {
		if (!id) throw new Error("wait: stop needs an id. " + runningList(reg));
		const job = reg.get(id);
		if (!job) throw new Error(`no job "${id}". ${runningList(reg)}`);
		if (job.delivered) throw new Error(`job ${job.id} was already collected.`);
		state.waiting.add(job.id);
		let taken: ReturnType<typeof reg.take>;
		try {
			reg.cancel(job.id, "stopped by wait");
			await job.settled;
			taken = reg.take(job.id);
		} finally {
			state.waiting.delete(job.id);
		}
		if (taken.kind !== "delivered") throw new Error(`job ${job.id} was already collected.`);
		const age = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
		return {
			content: [{ type: "text" as const, text: `[background] ${job.tool} job ${job.id} stopped after ${age} (${job.status}).` }],
			details: { keepalive: { running: false, id: job.id, tool: job.tool, label: job.label, status: job.status, durationMs: (job.endedAt ?? Date.now()) - job.startedAt } },
		};
	}

	let target: Job | undefined;
	if (id) {
		target = reg.get(id);
		if (!target) throw new Error(`no job "${id}". ${runningList(reg)}`);
		if (target.delivered) throw new Error(`job ${id} was already collected; its result is in the earlier wait output. Do not wait for it again.`);
	} else if (reg.running().length === 0 && reg.pending().length === 0) {
		throw new Error("no [background] job is running; nothing to wait for.");
	}

	const key = target?.id ?? "*";
	state.waiting.add(key);
	const onAbort = () => {
		if (target) reg.cancel(target.id, "aborted");
		else for (const j of reg.running()) reg.cancel(j.id, "aborted");
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const { ms } = keepaliveDeadlineMs(kit, cacheModelOf(ctx), kit.config("keepalive", KEEPALIVE_DEFAULTS), state.requestStartedAt);
		const deadline = ms === null ? null : (state.deadlineMsOverride ?? ms);
		const settling: Promise<Job | undefined> = target ? target.settled : reg.waitAny();
		const outcome = deadline === null ? await settling : await raceDeadline(settling, deadline);
		if (outcome === DEADLINE) return stillRunningList(reg, target);
		const job = outcome as Job | undefined;
		if (!job) throw new Error("no [background] job is running; nothing to wait for.");
		const taken = reg.take(job.id);
		if (taken.kind !== "delivered") throw new Error(`job ${job.id} was already collected.`);
		const durationMs = (job.endedAt ?? Date.now()) - job.startedAt;
		if (job.status !== "done") throw toError(taken.error);
		const r = (taken.value ?? {}) as { content?: unknown; details?: unknown; usage?: Usage };
		const content = (Array.isArray(r.content) ? r.content : [{ type: "text", text: resultText(r) }]) as WaitResult["content"];
		const details = r.details && typeof r.details === "object" && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : {};
		return {
			content,
			details: { ...details, keepalive: { running: false, id: job.id, tool: job.tool, label: job.label, status: job.status, durationMs } },
			usage: r.usage,
		};
	} finally {
		state.waiting.delete(key);
		signal?.removeEventListener("abort", onAbort);
	}
}

function runningList(reg: KeepaliveStateRegistry): string {
	const running = reg.running();
	return running.length ? `Running: ${running.map((j) => `${j.id} (${j.tool})`).join(", ")}.` : "Nothing is running.";
}

type KeepaliveStateRegistry = typeof state.registry;

function stillRunningList(reg: KeepaliveStateRegistry, target: Job | undefined, now = Date.now()): WaitResult {
	const describe = (j: Job) => `${j.tool} job ${j.id} (${formatDuration(now - j.startedAt)}: ${j.label})`;
	const running = reg.running();
	let text: string;
	if (target) {
		const others = running.filter((j) => j.id !== target.id);
		text = `[background] ${describe(target)} still running. Call wait({id:"${target.id}"}) again without a timeout; this check-in kept the prompt cache warm.`;
		if (others.length) text += `\nAlso running: ${others.map(describe).join("; ")}.`;
	} else {
		text = `[background] still running: ${running.map(describe).join("; ")}. Call wait again without a timeout; this check-in kept the prompt cache warm.`;
	}
	return {
		content: [{ type: "text" as const, text }],
		details: { keepalive: { running: true, id: target?.id ?? "*", tool: target?.tool ?? "any", label: target?.label ?? running.map((j) => j.id).join(", ") } },
	};
}

function deliverFollowUp(pi: ExtensionAPI, kit: Toolkit, job: Job): void {
	if (job.delivered) return;
	const taken = state.registry.take(job.id);
	if (taken.kind !== "delivered") return;
	// Cancelled means someone stopped it on purpose (escape, stop, shutdown): no new turn for that.
	if (job.status === "cancelled") return;
	const age = formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
	let body: string;
	if (job.status === "done") body = head(resultText(taken.value), FOLLOWUP_HEAD_BYTES);
	else body = `${job.status}: ${head(toError(taken.error).message, FOLLOWUP_HEAD_BYTES)}`;
	const verb = job.status === "done" ? "finished" : "failed";
	try {
		pi.sendMessage(
			{ customType: "toolkit-keepalive", content: `[background] job ${job.id} ${verb} (${job.tool}, ${age}):\n${body}`, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		kit.log("keepalive", `sendMessage failed for ${job.id}: ${String(error)}`);
	}
}

function head(text: string, bytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= bytes) return text;
	const cut = Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8").replace(/�+$/, "");
	return `${cut}\n… [cut at ${bytes} bytes; use wait for the full result next time]`;
}

function setTtl(kit: Toolkit, ctx: ExtensionCommandContext, key: string | undefined, secs: string | undefined): void {
	const seconds = Number.parseInt(secs ?? "", 10);
	if (!key || !key.includes("/") || !Number.isFinite(seconds) || seconds < 0) {
		ctx.ui.notify("Usage: /keepalive ttl <provider/model> <seconds>   (0 disables check-ins)", "error");
		return;
	}
	const raw = (kit.settings.keepalive && typeof kit.settings.keepalive === "object" ? kit.settings.keepalive : {}) as Record<string, unknown>;
	const overrides = { ...((raw.ttlOverrides as Record<string, number> | undefined) ?? {}), [key]: seconds };
	kit.saveConfig("keepalive", { ...raw, ttlOverrides: overrides });
	ctx.ui.notify(`keepalive: ${key} → ${seconds === 0 ? "check-ins disabled" : `${seconds}s TTL`}`, "info");
}

function showStatus(kit: Toolkit, ctx: ExtensionCommandContext, cfg: KeepaliveConfig): void {
	const model = cacheModelOf(ctx);
	const key = model ? `${model.provider}/${model.id}` : "none";
	const info = keepaliveDeadlineMs(kit, model, cfg, state.requestStartedAt);
	const lines = [
		`model        ${key}`,
		`policy       ${info.policy.checkInSeconds === null ? "no check-ins" : `${info.policy.checkInSeconds}s`} — ${info.policy.note}`,
		`rebuild      ${info.expensive ? "expensive (input/cacheRead ≥ 3): check-ins pay" : "cheap: the tool blocks as before"}`,
		`detach       ${info.ms === null ? "never" : `after ${formatDuration(info.ms)} of a call (margin ${cfg.marginSeconds}s)`}`,
		`hard cap     ${cfg.maxJobMinutes} min`,
	];
	const overrides = Object.entries(cfg.ttlOverrides);
	if (overrides.length) lines.push(`overrides    ${overrides.map(([k, v]) => `${k}=${v}s`).join(", ")}`);
	const jobs = state.registry.all();
	lines.push("", jobs.length ? "jobs:" : "jobs: none");
	for (const job of jobs) lines.push(`  ${describeJob(job)}`);
	kit.print("keepalive", ["prompt-cache check-ins for long tool calls"], lines, "ok");
}
