/**
 * subagent — `delegate`: spawn capped child pi processes with a role.
 *
 * Main session: registers `delegate` (single task or a `tasks` batch run up to
 * `maxParallel` at once), `/subagents`, and wraps the run with the keepalive
 * module so a long batch detaches at the cache deadline and is collected with
 * `wait`. Roles, models, thinking and caps live in
 * `<agent-dir>/toolkit/subagents.json` (see roles.ts), re-read on every call.
 *
 * Child process (PI_TOOLKIT_ROLE set): no `delegate` (so no nesting), only the
 * caps and the role gate from child.ts.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { FrameBottom, type FrameRowState, FrameTop, textOf, toLines } from "../../core/frame.ts";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { formatCount, formatDuration, formatUsd } from "../../core/text.ts";
import { runWithKeepalive } from "../keepalive/api.ts";
import { setupChild } from "./child.ts";
import { type ModelLike, modelKey, resolveModel } from "./models.ts";
import { isLocalModel, probeReachable, type ReachModel } from "./reach.ts";
import {
	effectiveTokenCap,
	isThinkingLevel,
	loadSubagentsConfig,
	raisedTokenCap,
	type RoleSpec,
	type SubagentsConfig,
	subagentsConfigPath,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./roles.ts";
import { buildChildCommand, runChild, type RunOutcome } from "./spawn.ts";
import { addUsage, emptyUsage, SPEND_ENTRY, type SpendEntry, type UsageSum, usageTokens } from "./usage.ts";

const REPORT_CAP_BYTES = 16 * 1024;

export interface TaskInput {
	role: string;
	task: string;
	context?: string;
	ownedFiles?: string[];
	model?: string;
	thinking?: string;
}

export interface DelegateParams extends Partial<TaskInput> {
	maxTurns?: number;
	maxTokens?: number;
	tasks?: TaskInput[];
	background?: boolean;
}

interface Plan {
	index: number;
	role: string;
	spec: RoleSpec;
	task: string;
	model: ModelLike;
	thinking: ThinkingLevel;
	maxTurns: number;
	/** 0 = no token cap (a local model). */
	maxTokens: number;
	timeoutSec: number;
	ownedFiles: string[] | undefined;
	/** e.g. "local/qwen unreachable, using deepseek/deepseek-v4-flash". */
	note?: string;
}

interface TaskRun {
	plan: Plan;
	outcome?: RunOutcome;
	error?: Error;
}

export interface TaskDetails {
	role: string;
	task: string;
	model: string;
	thinking: string;
	turns: number;
	maxTurns: number;
	tokens: number;
	maxTokens: number;
	costUsd: number;
	durationMs: number;
	stopReason: string;
	killed?: string;
	error?: string;
	/** Set when a local model was unreachable and a fallback was used. */
	note?: string;
}

export interface DelegateDetails extends TaskDetails {
	batch: boolean;
	/** The result's usage is already booked as SPEND_ENTRY entries; the footer must not count it again. */
	spendBooked: true;
	tasks?: TaskDetails[];
}

const module: ToolkitModule = {
	id: "subagent",
	label: "Subagents",
	description: "delegate: capped child pi processes with a role (researcher, scout, finder, git, web, test, worker, session)",
	default: true,
	order: 55,
	child: "always",
	setup(pi, kit) {
		if (kit.role.isChild) {
			setupChild(pi, kit);
			return;
		}
		const configPath = subagentsConfigPath(kit.paths.toolkitDir);
		const roleNames = Object.keys(loadSubagentsConfig(configPath).roles);
		const taskItem = Type.Object({
			role: StringEnum(roleNames),
			task: Type.String(),
			context: Type.Optional(Type.String()),
			ownedFiles: Type.Optional(Type.Array(Type.String())),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
		});

		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Spawn a capped child pi with a role to do one scoped task and return its report. Roles: researcher (codebase questions with path:line evidence), scout (which files matter), finder (paths and line numbers only), git (history/blame), web (web research with URLs), test (run the test command), worker (implement inside ownedFiles), session (what earlier sessions did). The child sees nothing of this conversation: put everything it needs in task and context. Use tasks for several independent jobs at once.",
			promptSnippet: "Delegate a scoped task (or a batch) to a capped child agent with a role: researcher, scout, finder, git, web, test, worker, session",
			promptGuidelines: [
				"Use delegate for work this context does not need to see: 3+ independent targets → one worker each in tasks (each with its own ownedFiles); research spanning more than 3 files not in context → researcher or scout; web questions → web; \"what did we do before\" → session; running tests → test.",
				"Give each child one question over a bounded area (a directory or a file list). Split a broad sweep (\"find bugs\", \"audit the app\") into 2-4 tasks with disjoint areas in one tasks batch: one child covering everything runs into its caps, and overlapping tasks return the same findings.",
				"If you have other work to do while a delegate runs, pass background:true and keep going. A delegate report is a claim: collect every one (wait for any [background] job) and verify what matters before relying on it.",
			],
			parameters: Type.Object({
				role: Type.Optional(StringEnum(roleNames, { description: "The child's role" })),
				task: Type.Optional(Type.String({ description: "What to do, self-contained (the child has no access to this conversation)" })),
				context: Type.Optional(Type.String({ description: "Facts already known: paths, decisions, constraints — so the child does not rediscover them" })),
				ownedFiles: Type.Optional(Type.Array(Type.String(), { description: "worker only: the paths it may edit (files or directories)" })),
				model: Type.Optional(Type.String({ description: "Override the role's model: inherit | cheap | provider/id" })),
				thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Override the role's thinking level" })),
				maxTurns: Type.Optional(Type.Number({ description: "Override the role's turn cap" })),
				maxTokens: Type.Optional(
					Type.Number({ description: `Raise the role's token budget: input+output+cache summed over every turn, not an output limit. Only raises it: a value at or under the role's budget changes nothing; local models run uncapped` }),
				),
				tasks: Type.Optional(Type.Array(taskItem, { description: "Batch: run these concurrently; top-level role/task are ignored" })),
				background: Type.Optional(Type.Boolean({ description: "Return at once with a job id and run in the background; collect the report later with wait({id})" })),
			}),
			renderShell: "self",
			execute: (toolCallId, params, signal, onUpdate, ctx) => delegateExecute(pi, kit, configPath, params as DelegateParams, toolCallId, signal, onUpdate, ctx),
			renderCall(args, theme, context) {
				const st = context.state as FrameRowState & { summary?: string };
				const head = [st.summary ?? describeArgs(args as DelegateParams)];
				const frameState = st.done ? (st.error ? "error" : "ok") : "running";
				const top = context.lastComponent instanceof FrameTop ? context.lastComponent : new FrameTop("DELEGATE", head, frameState, theme);
				return top.update("DELEGATE", head, frameState, true);
			},
			renderResult(result, options, theme, context) {
				const st = context.state as FrameRowState & { summary?: string };
				const d = result?.details as (Partial<DelegateDetails> & { progress?: string[]; keepalive?: { running?: boolean } }) | undefined;
				if (options.isPartial) {
					const lines = Array.isArray(d?.progress) ? d.progress : toLines(textOf(result));
					const body = { lines, expanded: true, color: "muted" };
					const bottom = context.lastComponent instanceof FrameBottom ? context.lastComponent : new FrameBottom(body, theme);
					return bottom.update(body, []);
				}
				st.done = true;
				st.error = context.isError;
				if (d && !d.keepalive?.running && typeof d.role === "string") st.summary = summarize(d);
				if (!st.invalidated) {
					st.invalidated = true;
					// Deferred: a synchronous invalidate re-enters pi's row update mid-render.
					queueMicrotask(() => {
						try {
							context.invalidate();
						} catch {}
					});
				}
				const footer: string[] = [];
				if (d?.killed) footer.push(`killed: ${d.killed}`);
				if (d?.batch && Array.isArray(d.tasks)) for (const t of d.tasks) footer.push(`${t.role}: ${t.turns}/${t.maxTurns} turns · ${formatCount(t.tokens)} tok · ${formatUsd(t.costUsd)}${t.killed ? ` · killed (${t.killed})` : ""}${t.error ? " · failed" : ""}`);
				const body = { lines: toLines(textOf(result)), expanded: options.expanded, maxLines: 6 };
				const bottom = context.lastComponent instanceof FrameBottom ? context.lastComponent : new FrameBottom(body, theme, footer);
				return bottom.update(body, footer);
			},
		});

		pi.registerCommand("subagents", {
			description: "Subagent roles, resolved models and caps (/subagents edit prints the config path)",
			handler: async (args, ctx) => {
				if ((args ?? "").trim() === "edit") {
					ctx.ui.notify(`Edit ${configPath} — re-read on every delegate call (restart to refresh the role list).`, "info");
					return;
				}
				showRoles(kit, ctx, loadSubagentsConfig(configPath), configPath);
			},
		});
	},
};
export default module;

function firstLine(text: string, max = 80): string {
	const line = (text ?? "").replace(/\r\n?/g, "\n").split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describeArgs(a: DelegateParams | undefined): string {
	const bg = a?.background ? " · background" : "";
	if (a?.tasks?.length) return `${a.tasks.length} tasks · ${a.tasks.map((t) => t.role).join(", ")}${bg}`;
	return `${a?.role ?? "?"} · ${firstLine(a?.task ?? "")}${bg}`;
}

function summarize(d: Partial<DelegateDetails>): string {
	if (d.batch && Array.isArray(d.tasks)) return `${d.tasks.length} tasks · ${d.turns ?? 0} turns · ${formatCount(d.tokens ?? 0)} tok · ${formatUsd(d.costUsd ?? 0)}`;
	return `${d.role} · ${d.model} · ${d.turns ?? 0}/${d.maxTurns ?? "?"} turns · ${formatCount(d.tokens ?? 0)} tok · ${formatUsd(d.costUsd ?? 0)}`;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

/** What the parent appends to the child's system prompt: role prompt, caps, report format. */
export function childPrompt(spec: RoleSpec, caps: { maxTurns: number; maxTokens: number; ownedFiles?: string[] }): string {
	const parts = [
		spec.prompt.trim(),
		`Limits: at most ${caps.maxTurns} turns${caps.maxTokens > 0 ? ` and ${formatCount(caps.maxTokens)} tokens in total` : ""}; the run is killed past them, so budget your tool calls and stop early with what you have.`,
	];
	if (caps.ownedFiles?.length) parts.push(`You own only these paths (edits and shell writes elsewhere are blocked): ${caps.ownedFiles.join(", ")}.`);
	parts.push(
		"Report format: your final message is the report the caller reads verbatim. Findings first, each with its evidence (path:line or URL); then what you could not determine. No preamble and no questions back — nobody answers them.",
	);
	return parts.filter((p) => p.length > 0).join("\n\n");
}

function normalizeTasks(params: DelegateParams): TaskInput[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) return params.tasks;
	if (params.role && params.task) return [{ role: params.role, task: params.task, context: params.context, ownedFiles: params.ownedFiles, model: params.model, thinking: params.thinking }];
	throw new Error("delegate needs role + task, or a tasks array");
}

function planTask(input: TaskInput, index: number, params: DelegateParams, cfg: SubagentsConfig, ctx: ExtensionContext): Plan {
	const spec = cfg.roles[input.role];
	if (!spec) throw new Error(`unknown role "${input.role}". Roles: ${Object.keys(cfg.roles).join(", ")}`);
	const task = (input.task ?? "").trim();
	if (!task) throw new Error(`task #${index + 1} (${input.role}) has no task text`);
	const ownedFiles = Array.isArray(input.ownedFiles) ? input.ownedFiles.filter((p) => typeof p === "string" && p.trim() !== "") : undefined;
	if (input.role === "worker" && !(ownedFiles && ownedFiles.length > 0)) throw new Error(`task #${index + 1}: a worker needs ownedFiles (the paths it may edit)`);
	let available: ModelLike[] = [];
	try {
		available = (ctx.modelRegistry?.getAvailable?.() ?? []) as unknown as ModelLike[];
	} catch {}
	const model = resolveModel(input.model ?? spec.model, {
		current: ctx.model as unknown as ModelLike | undefined,
		available,
		cheapModels: cfg.cheapModels,
		find: (provider, id) => {
			try {
				return ctx.modelRegistry?.find?.(provider, id) as unknown as ModelLike | undefined;
			} catch {
				return undefined;
			}
		},
	});
	const thinking = isThinkingLevel(input.thinking) ? input.thinking : spec.thinking;
	const maxTurns = positiveInt(params.maxTurns) ?? spec.maxTurns;
	const maxTokens = raisedTokenCap(spec.maxTokens, positiveInt(params.maxTokens));
	const context = (input.context ?? "").trim();
	const fullTask = context ? `${task}\n\nKnown context from the caller (trust it; do not rediscover it):\n${context}` : task;
	return {
		index,
		role: input.role,
		spec,
		task: fullTask,
		model,
		thinking,
		maxTurns,
		maxTokens,
		timeoutSec: spec.timeoutSec ?? cfg.defaultTimeoutSec,
		ownedFiles,
	};
}

async function runPlan(plan: Plan, kit: Toolkit, ctx: ExtensionContext, signal: AbortSignal | undefined, onProgress: (line: string) => void): Promise<TaskRun> {
	const cmd = buildChildCommand({
		extensionEntry: join(kit.paths.root, "index.ts"),
		cwd: ctx.cwd,
		role: plan.role,
		task: plan.task,
		model: modelKey(plan.model),
		thinking: plan.thinking,
		tools: plan.spec.tools,
		appendSystemPrompt: childPrompt(plan.spec, { maxTurns: plan.maxTurns, maxTokens: plan.maxTokens, ownedFiles: plan.ownedFiles }),
		depth: kit.role.depth + 1,
		maxTurns: plan.maxTurns,
		maxTokens: plan.maxTokens,
		ownedFiles: plan.ownedFiles,
		allow: plan.spec.allow,
	});
	kit.log("subagent", `spawn ${plan.role} on ${modelKey(plan.model)} (${plan.maxTurns} turns, ${plan.maxTokens > 0 ? `${plan.maxTokens} tokens` : "no token cap"})`);
	try {
		const outcome = await runChild({ ...cmd, cwd: ctx.cwd, maxTurns: plan.maxTurns, maxTokens: plan.maxTokens, timeoutSec: plan.timeoutSec, signal, onProgress });
		return { plan, outcome };
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		const outcome = (err as { outcome?: RunOutcome }).outcome;
		return { plan, outcome, error: err };
	}
}

async function runPool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const results: T[] = new Array(jobs.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
		while (next < jobs.length) {
			const i = next++;
			results[i] = await jobs[i]();
		}
	});
	await Promise.all(workers);
	return results;
}

function taskDetails(run: TaskRun): TaskDetails {
	const { plan, outcome } = run;
	return {
		role: plan.role,
		task: firstLine(plan.task, 120),
		model: modelKey(plan.model),
		thinking: plan.thinking,
		turns: outcome?.turns ?? 0,
		maxTurns: plan.maxTurns,
		tokens: outcome ? usageTokens(outcome.usage) : 0,
		maxTokens: plan.maxTokens,
		costUsd: outcome?.usage.cost.total ?? 0,
		durationMs: outcome?.durationMs ?? 0,
		stopReason: outcome?.stopReason ?? (run.error ? "error" : "unknown"),
		killed: outcome?.killed,
		error: run.error?.message,
		note: plan.note,
	};
}

/**
 * A local model server that does not answer gets swapped for the role's
 * `fallback`, else the next cheap model that is not local, before spawning.
 */
async function ensureReachable(plan: Plan, cfg: SubagentsConfig, ctx: ExtensionContext): Promise<void> {
	for (let hop = 0; hop < 3 && isLocalModel(plan.model as ReachModel); hop++) {
		const baseUrl = (plan.model as ReachModel).baseUrl ?? providerBaseUrl(ctx, plan.model.provider);
		if (await probeReachable(baseUrl)) return;
		const dead = modelKey(plan.model);
		let available: ModelLike[] = [];
		try {
			available = ((ctx.modelRegistry?.getAvailable?.() ?? []) as unknown as ModelLike[]).filter((m) => modelKey(m) !== dead);
		} catch {}
		const opts = {
			current: ctx.model as unknown as ModelLike | undefined,
			available,
			cheapModels: cfg.cheapModels.filter((k) => k !== dead),
			find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
		};
		const next = plan.spec.fallback && plan.spec.fallback !== dead ? resolveModel(plan.spec.fallback, opts) : resolveModel("cheap", opts);
		plan.note = `${dead} unreachable, using ${modelKey(next)}`;
		plan.model = next;
	}
}

/** Running children, published as the "subagent" extension status for the footer's `agents` chip. */
let runningChildren = 0;
function publishRunning(ctx: ExtensionContext): void {
	try {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("subagent", runningChildren > 0 ? `${runningChildren} running` : undefined);
	} catch {}
}
function childStarted(ctx: ExtensionContext): void {
	runningChildren++;
	publishRunning(ctx);
}
function childEnded(ctx: ExtensionContext): void {
	runningChildren = Math.max(0, runningChildren - 1);
	publishRunning(ctx);
}

function providerBaseUrl(ctx: ExtensionContext, provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	try {
		const reg = ctx.modelRegistry as unknown as { getProvider?: (id: string) => { baseUrl?: string } | undefined };
		return reg.getProvider?.(provider)?.baseUrl;
	} catch {
		return undefined;
	}
}

function taskReport(run: TaskRun): string {
	const { plan, outcome, error } = run;
	const parts: string[] = [];
	if (outcome?.killed) parts.push(`[killed: ${outcome.killed} after ${outcome.turns} turns, ${formatCount(usageTokens(outcome.usage))} tokens — partial report follows]`);
	if (error && !outcome?.report.trim()) parts.push(`[${plan.role} failed: ${error.message}]`);
	else if (error) parts.push(`[${plan.role} exited with an error: ${error.message}]`);
	if (outcome?.report.trim()) parts.push(outcome.report.trim());
	else if (!error) parts.push(`[${plan.role} produced no report${outcome?.errorMessage ? `: ${outcome.errorMessage}` : ""}]`);
	return parts.join("\n\n");
}

export function capReport(text: string, cap = REPORT_CAP_BYTES): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= cap) return text;
	const head = Buffer.from(text, "utf8").subarray(0, cap).toString("utf8").replace(/�+$/, "");
	return `${head}\n\n[report cut at ${Math.round(cap / 1024)}KB; ${bytes - cap} more bytes not shown]`;
}

/** Book a finished child's usage as a session entry, so the footer total includes it however the call ends. */
function bookSpend(pi: ExtensionAPI, kit: Toolkit, run: TaskRun): void {
	const usage = run.outcome?.usage;
	if (!usage || usageTokens(usage) === 0) return;
	try {
		pi.appendEntry<SpendEntry>(SPEND_ENTRY, { tool: "delegate", role: run.plan.role, model: modelKey(run.plan.model), usage });
	} catch (error) {
		kit.log("subagent", `spend entry failed: ${String(error)}`);
	}
}

async function delegateExecute(
	pi: ExtensionAPI,
	kit: Toolkit,
	configPath: string,
	params: DelegateParams,
	toolCallId: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
	ctx: ExtensionContext,
) {
	const cfg = loadSubagentsConfig(configPath);
	const inputs = normalizeTasks(params);
	const plans = inputs.map((input, i) => planTask(input, i, params, cfg, ctx));
	await Promise.all(plans.map((plan) => ensureReachable(plan, cfg, ctx)));
	for (const plan of plans) plan.maxTokens = effectiveTokenCap(plan.maxTokens, isLocalModel(plan.model as ReachModel));
	const batch = plans.length > 1 || Array.isArray(params.tasks);
	const label = plans.length === 1 ? `${plans[0].role}: ${firstLine(plans[0].task, 60)}` : `${plans.length} tasks: ${plans.map((p) => p.role).join(", ")}`;
	const progress = plans.map((p) => `${p.role} #${p.index + 1} · queued`);
	let live = true;
	const update = () => {
		if (!live || !onUpdate) return;
		try {
			onUpdate({ content: [{ type: "text", text: progress.join("\n") }], details: { running: true, progress: [...progress] } });
		} catch {}
	};

	const work = async (s: AbortSignal | undefined) => {
		const runs = await runPool(
			plans.map((plan) => async () => {
				progress[plan.index] = `${plan.role} #${plan.index + 1} · starting on ${modelKey(plan.model)}${plan.note ? ` (${plan.note})` : ""}`;
				update();
				childStarted(ctx);
				try {
					const run = await runPlan(plan, kit, ctx, s, (line) => {
						progress[plan.index] = `${plan.role} #${plan.index + 1} · ${line}`;
						update();
					});
					bookSpend(pi, kit, run);
					return run;
				} finally {
					childEnded(ctx);
				}
			}),
			cfg.maxParallel,
		);
		return composeResult(runs, batch);
	};

	return runWithKeepalive(kit, ctx, {
		tool: "delegate",
		label: label.slice(0, 80),
		toolCallId,
		signal,
		background: params.background === true,
		onDetach: () => {
			live = false;
		},
		work,
	});
}

function composeResult(runs: TaskRun[], batch: boolean): { content: Array<{ type: "text"; text: string }>; details: DelegateDetails; usage: UsageSum } {
	const usage = emptyUsage();
	for (const run of runs) if (run.outcome) addUsage(usage, run.outcome.usage);
	const details = runs.map(taskDetails);
	if (!batch) {
		const run = runs[0];
		if (run.error && !run.outcome?.report.trim()) throw run.error;
		return { content: [{ type: "text", text: capReport(taskReport(run)) }], details: { ...details[0], batch: false, spendBooked: true }, usage };
	}
	if (runs.every((r) => r.error && !r.outcome?.report.trim())) {
		throw new Error(`all ${runs.length} tasks failed:\n${runs.map((r) => `- ${r.plan.role} #${r.plan.index + 1}: ${r.error?.message}`).join("\n")}`);
	}
	const sections = runs.map((run) => `## ${run.plan.role} #${run.plan.index + 1}: ${firstLine(run.plan.task)}\n\n${taskReport(run)}`);
	const models = [...new Set(details.map((d) => d.model))];
	const summary: DelegateDetails = {
		batch: true,
		spendBooked: true,
		tasks: details,
		role: "batch",
		task: details.map((d) => d.role).join(", "),
		model: models.join(", "),
		thinking: [...new Set(details.map((d) => d.thinking))].join(", "),
		turns: details.reduce((n, d) => n + d.turns, 0),
		maxTurns: details.reduce((n, d) => n + d.maxTurns, 0),
		tokens: details.reduce((n, d) => n + d.tokens, 0),
		maxTokens: details.reduce((n, d) => n + d.maxTokens, 0),
		costUsd: usage.cost.total,
		durationMs: Math.max(0, ...details.map((d) => d.durationMs)),
		stopReason: details.some((d) => d.killed) ? "killed" : details.some((d) => d.error) ? "error" : "stop",
		killed: details.filter((d) => d.killed).map((d) => `${d.role}: ${d.killed}`).join("; ") || undefined,
	};
	return { content: [{ type: "text", text: capReport(sections.join("\n\n")) }], details: summary, usage };
}

function showRoles(kit: Toolkit, ctx: ExtensionCommandContext, cfg: SubagentsConfig, configPath: string): void {
	let available: ModelLike[] = [];
	try {
		available = (ctx.modelRegistry?.getAvailable?.() ?? []) as unknown as ModelLike[];
	} catch {}
	const lines = Object.entries(cfg.roles).map(([name, r]) => {
		let model: string;
		let tokenCap = effectiveTokenCap(r.maxTokens, false);
		try {
			const resolved = resolveModel(r.model, { current: ctx.model as unknown as ModelLike | undefined, available, cheapModels: cfg.cheapModels });
			model = modelKey(resolved);
			tokenCap = effectiveTokenCap(r.maxTokens, isLocalModel(resolved as ReachModel));
		} catch {
			model = `?? ${r.model}`;
		}
		const caps = `${String(r.maxTurns).padStart(3)}t ${(tokenCap > 0 ? formatCount(tokenCap) : "no cap").padStart(6)}`;
		return `${name.padEnd(11)} ${model.padEnd(38)} ${r.thinking.padEnd(7)} ${caps}  ${r.tools.join(",")}`;
	});
	lines.push("", `models: inherit = ${modelKey(ctx.model as unknown as ModelLike | undefined)} · cheap = ${cfg.cheapModels.join(" > ")}`);
	kit.print("subagents", [`${Object.keys(cfg.roles).length} roles · maxParallel ${cfg.maxParallel} · timeout ${formatDuration(cfg.defaultTimeoutSec * 1000)} · ${configPath}`], lines, "ok");
}
