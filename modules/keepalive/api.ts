/**
 * `runWithKeepalive`: wrap a long tool call so it returns a "[background] …
 * still running" reply just before the provider's prompt cache would expire,
 * while the work continues as a job that `wait` collects.
 *
 * Other modules import this (the subagent module wraps `delegate` with it).
 * The module-level `state` is shared with index.ts, which tracks request
 * starts, registers `wait`, and pushes idle finishes as follow-up messages.
 */
import { type CacheModelLike, type CachePolicy, cachePolicyFor, rebuildIsExpensive } from "../../core/cache-policy.ts";
import type { Toolkit } from "../../core/kit.ts";
import { formatDuration } from "../../core/text.ts";
import { DEADLINE, type Job, JobRegistry, type JobStatus, raceDeadline } from "./jobs.ts";

export interface KeepaliveConfig {
	/** Seconds subtracted from the cache TTL: generation before the call plus request latency. */
	marginSeconds: number;
	/** `{"provider/id": seconds}`; 0 disables check-ins for that model. */
	ttlOverrides: Record<string, number>;
	/** A job is killed after this long. */
	maxJobMinutes: number;
}

export const KEEPALIVE_DEFAULTS: KeepaliveConfig = { marginSeconds: 45, ttlOverrides: {}, maxJobMinutes: 60 };

/** Never detach sooner than this: a check-in costs a request. */
export const MIN_DEADLINE_MS = 30_000;

export interface KeepaliveDetails {
	running: boolean;
	id: string;
	tool: string;
	label: string;
	status?: JobStatus;
	durationMs?: number;
}

export interface KeepaliveReply {
	content: Array<{ type: "text"; text: string }>;
	details: { keepalive: KeepaliveDetails };
}

/** The slice of pi's ExtensionContext the wrapper reads. Structural, so tests pass a literal. */
export interface KeepaliveCtx {
	/** pi's Model; read through `cacheModelOf`. */
	model?: unknown;
	isIdle?: () => boolean;
}

/** The model as the cache policy sees it. */
export function cacheModelOf(ctx: KeepaliveCtx | undefined): CacheModelLike | undefined {
	const model = ctx?.model;
	return model && typeof model === "object" ? (model as CacheModelLike) : undefined;
}

export interface KeepaliveState {
	registry: JobRegistry;
	/** When the current LLM request started (agent_start / turn_start). */
	requestStartedAt: number | undefined;
	/** Job ids a `wait` call is blocked on ("*" for any). */
	waiting: Set<string>;
	/** The last context seen, for `isIdle()` in the settle listener. */
	lastCtx: KeepaliveCtx | undefined;
	/** Test seam: replaces the computed deadline for the wrapper and `wait`. */
	deadlineMsOverride: number | undefined;
}

export const state: KeepaliveState = {
	registry: new JobRegistry(),
	requestStartedAt: undefined,
	waiting: new Set(),
	lastCtx: undefined,
	deadlineMsOverride: undefined,
};

/** Fresh state; tests call this before `module.setup`. */
export function resetKeepaliveState(): void {
	state.registry.cancelAll("reset");
	state.registry = new JobRegistry();
	state.requestStartedAt = undefined;
	state.waiting.clear();
	state.lastCtx = undefined;
	state.deadlineMsOverride = undefined;
}

export interface DeadlineInfo {
	/** Milliseconds a call may block before it should hand control back; null = block as before. */
	ms: number | null;
	policy: CachePolicy;
	expensive: boolean;
}

/** How long a call starting now may block before the cache would expire. */
export function keepaliveDeadlineMs(kit: Toolkit, model: CacheModelLike | undefined, cfg: KeepaliveConfig, requestStartedAt: number | undefined, now = Date.now()): DeadlineInfo {
	const policy = cachePolicyFor(model, cfg.ttlOverrides);
	const expensive = rebuildIsExpensive(model);
	if (!kit.enabled.has("keepalive") || policy.checkInSeconds === null || !expensive) return { ms: null, policy, expensive };
	const since = requestStartedAt === undefined ? 0 : Math.max(0, (now - requestStartedAt) / 1000);
	const ms = Math.max(MIN_DEADLINE_MS, Math.round((policy.checkInSeconds - cfg.marginSeconds - since) * 1000));
	return { ms, policy, expensive };
}

export interface KeepaliveOptions<T> {
	tool: string;
	label: string;
	toolCallId: string;
	work: (signal: AbortSignal | undefined) => Promise<T>;
	signal?: AbortSignal;
	requestStartedAt?: number;
	/** Test seam: replaces the computed deadline (policy gating still applies). */
	deadlineMsOverride?: number;
	/** Called once when the call detaches, so the caller can stop streaming partials into a finished row. */
	onDetach?: () => void;
	/** The model asked to detach at once: return the job reply now, whatever the cache policy. Needs the keepalive module for `wait`. */
	background?: boolean;
}

/**
 * Run `work`; below the deadline the call returns exactly what the work
 * returned (or rethrows what it threw). At the deadline it returns a
 * `KeepaliveReply` and the work goes on as a job for `wait`.
 */
export async function runWithKeepalive<T>(kit: Toolkit, ctx: KeepaliveCtx | undefined, opts: KeepaliveOptions<T>): Promise<T | KeepaliveReply> {
	if (ctx) state.lastCtx = ctx;
	const cfg = kit.config("keepalive", KEEPALIVE_DEFAULTS);
	if (opts.background && kit.enabled.has("keepalive")) {
		// Detach before the work starts, so no partial update lands in the finished row.
		try {
			opts.onDetach?.();
		} catch {}
		const job = state.registry.start<T>({ tool: opts.tool, label: opts.label, run: (signal) => opts.work(signal), signal: opts.signal, hardCapMs: cfg.maxJobMinutes * 60_000 });
		kit.log("keepalive", `${opts.tool} started in background as ${job.id}`);
		return backgroundReply(job);
	}
	const { ms } = keepaliveDeadlineMs(kit, cacheModelOf(ctx), cfg, opts.requestStartedAt ?? state.requestStartedAt);
	const deadline = ms === null ? null : (opts.deadlineMsOverride ?? state.deadlineMsOverride ?? ms);
	if (deadline === null) return opts.work(opts.signal);

	const job = state.registry.start<T>({
		tool: opts.tool,
		label: opts.label,
		run: (signal) => opts.work(signal),
		signal: opts.signal,
		hardCapMs: cfg.maxJobMinutes * 60_000,
	});
	// While the call blocks inline, the settle listener must not push the result as a follow-up.
	state.waiting.add(job.id);
	let outcome: Job<T> | typeof DEADLINE;
	try {
		outcome = await raceDeadline(job.settled, deadline);
	} finally {
		state.waiting.delete(job.id);
	}
	if (outcome !== DEADLINE) {
		// Settled below the deadline: byte-identical to the unwrapped tool.
		const taken = state.registry.take<T>(job.id);
		if (job.status === "done" && taken.kind === "delivered") return taken.value as T;
		throw toError(job.error);
	}
	try {
		opts.onDetach?.();
	} catch {}
	kit.log("keepalive", `${opts.tool} detached as ${job.id} after ${deadline}ms`);
	return stillRunningReply(job);
}

export function stillRunningReply(job: Job, now = Date.now()): KeepaliveReply {
	const elapsed = formatDuration(now - job.startedAt);
	return {
		content: [
			{
				type: "text",
				text: `[background] ${job.tool} job ${job.id} still running after ${elapsed}. Call wait({id:"${job.id}"}) to collect it; do other useful work first if any, then wait without a timeout.`,
			},
		],
		details: { keepalive: { running: true, id: job.id, tool: job.tool, label: job.label } },
	};
}

export function backgroundReply(job: Job): KeepaliveReply {
	return {
		content: [
			{
				type: "text",
				text: `[background] ${job.tool} job ${job.id} started. Do your other work now, then collect it with wait({id:"${job.id}"}) before relying on it; if you end your turn first, its result arrives as a follow-up message.`,
			},
		],
		details: { keepalive: { running: true, id: job.id, tool: job.tool, label: job.label } },
	};
}

/** Text of a tool result's text blocks (any shape). */
export function resultText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return typeof result === "string" ? result : "";
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error ?? "failed"));
}

/** One line per job for status output. */
export function describeJob(job: Job, now = Date.now()): string {
	const age = formatDuration((job.endedAt ?? now) - job.startedAt);
	return `${job.id}  ${job.tool.padEnd(8)} ${job.status.padEnd(9)} ${age.padStart(7)}  ${job.label}`;
}
