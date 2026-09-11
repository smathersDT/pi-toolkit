/**
 * auto-learn — turn tool failures into short, expiring, per-repo lessons.
 *
 * Everything the model sees is written into the session once and never
 * rewritten afterwards, so the prompt cache keeps every earlier byte. (The
 * first version edited old tool results per request; each edit cost a cache
 * miss from that point on, measured at 13% of a session's spend.)
 *
 *   before_agent_start  lessons not yet in context ride in as a custom message
 *                       after the user prompt: all of them on the session's first
 *                       prompt, then whatever is new (or dropped by a compaction).
 *   tool_result         classify failures (policy.ts) and append a ~40-word note;
 *                       append lessons that appeared since the last delivery —
 *                       saved by this session's learn tool, a subagent or another
 *                       session — and every lesson of a repo the call just touched
 *                       (detect.ts). Delivered ids ride in the result's details.
 *   learn tool          save one lesson for a failure id (store.ts: shared file,
 *                       atomic write, lock). A near-duplicate is refused with the
 *                       existing text so the model can replace it instead.
 *   TUI (view.ts)       a ◆ LEARNED row per save, a ◆ INJECTED row per delivery
 *                       with a token estimate, and a `learn` footer status.
 *   /learn              list · forget <n> · on|off (main session only).
 *
 * A forgotten or expired lesson stays in context until a compaction drops it;
 * a compaction that drops one re-injects the current lessons.
 *
 * Subagent children (researcher/worker/git/test) load it too: same detection,
 * store and delivery, no TUI.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { FrameBottom, type FrameRowState, FrameTop, type FrameState, summaryLine, textOf as resultText, toLines } from "../../core/frame.ts";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { estimateTokens } from "../../core/text.ts";
import { callPaths, gitRootOf } from "./detect.ts";
import { classify, describeCall, type Failure, guidance, OWN_TOOLS, textOf } from "./policy.ts";
import { findRepo, knownRepos, type RepoIdentity, resolveRepo } from "./repo.ts";
import { forgetLesson, formatExpiry, type Lesson, type LessonOrigin, lessonFile, loadLessons, type StoreOptions, saveLesson } from "./store.ts";
import { type InjectedData, type InjectTrigger, injectedRow, learnedRow, shortRepo } from "./view.ts";

export type { InjectTrigger } from "./view.ts";

const ID = "auto-learn";
const DEFAULTS = { ttlDays: 7, maxPerRepo: 20, maxLessonChars: 800 };
/** Unresolved failures remembered per session. */
const MAX_FAILURES = 40;
/** customType of the display-only transcript rows: a save, or a delivery inside a tool result. */
export const CUSTOM_TYPE = "toolkit-learn";
/** customType of the custom messages that carry lessons to the model. */
export const LESSONS_TYPE = "toolkit-lessons";
/** Key under a tool result's details listing the lesson ids appended to it. */
export const DETAILS_KEY = "autoLearn";
/** Footer status key. */
export const STATUS_KEY = "learn";

interface ActiveRepo {
	repo: RepoIdentity;
	lessons: Lesson[];
	/** Store file mtime at the last load; -1 forces the next load. */
	mtime: number;
}

interface State {
	enabled: boolean;
	/** By toolCallId, insertion order = age. */
	failures: Map<string, Failure>;
	counter: number;
	/** The session's own repo (its cwd). */
	repo: RepoIdentity | undefined;
	/** Repos whose lessons reach this session: its own, plus every repo a tool call touched. */
	active: Map<string, ActiveRepo>;
	/** Ids of lessons already in the model's context. */
	inContext: Set<string>;
	/** Lessons this session's learn tool stored. */
	saved: number;
	/** A compaction dropped lessons; the next delivery says so. */
	compacted: boolean;
}

interface LearnParams {
	failureId: string;
	lesson: string;
	action?: "add" | "replace";
	replaces?: string[];
	repo?: string;
}

interface LearnDetails {
	status: "added" | "duplicate" | "replaced" | "handled" | "similar";
	repo: string;
	lesson: string;
	id?: string;
	expiresAt?: string;
	removed?: number;
	dropped?: number;
}

type Content = Array<{ type: string; text?: string; [key: string]: unknown }>;
type Entry = { type?: string; customType?: string; details?: any; message?: any };
type Group = { active: ActiveRepo; lessons: Lesson[] };

/** The text the model receives for one repo's lessons. */
export function lessonsBlock(label: string, lessons: Lesson[], ttlDays: number, trigger: InjectTrigger): string {
	const list = lessons.map((l) => `- ${l.text}`).join("\n");
	if (trigger === "turn") return `[auto-learn] New lesson${lessons.length === 1 ? "" : "s"} for ${label} (verify before relying on one):\n${list}`;
	if (trigger === "repo") return `[auto-learn] Lessons for ${label}, a repo this session just touched (expire after ${ttlDays} days; verify before relying on one):\n${list}`;
	return `Lessons from earlier failures in ${label} (auto-learn, expire after ${ttlDays} days; verify before relying on one):\n${list}`;
}

/** `content` with `note` appended to its last text block, or as a new block. */
export function withNote(content: unknown, note: string): Content {
	const out: Content = Array.isArray(content) ? [...(content as Content)] : [];
	let i = out.length - 1;
	while (i >= 0 && out[i]?.type !== "text") i--;
	if (i >= 0) out[i] = { ...out[i], text: `${out[i].text ?? ""}\n\n${note}` };
	else out.push({ type: "text", text: note });
	return out;
}

/** The entries pi builds the next request from (compaction-aware), or the branch on an older host. */
function contextEntries(ctx: any): Entry[] {
	const sm = ctx?.sessionManager;
	try {
		if (typeof sm?.buildContextEntries === "function") return sm.buildContextEntries() ?? [];
		if (typeof sm?.getBranch === "function") return sm.getBranch() ?? [];
	} catch {
		// No session yet.
	}
	return [];
}

const NOTE_ID = /\[auto-learn L(\d+)\]/g;

/** Lesson ids the model can already see, and the highest L<n> its failure notes used. */
export function scanContext(entries: Entry[]): { ids: Set<string>; lastFailure: number } {
	const ids = new Set<string>();
	let lastFailure = 0;
	for (const entry of entries) {
		if (entry?.type === "custom_message" && entry.customType === LESSONS_TYPE) {
			for (const lesson of entry.details?.lessons ?? []) if (typeof lesson?.id === "string") ids.add(lesson.id);
			continue;
		}
		const m = entry?.type === "message" ? entry.message : undefined;
		if (m?.role !== "toolResult") continue;
		for (const id of m.details?.[DETAILS_KEY]?.lessons ?? []) if (typeof id === "string") ids.add(id);
		for (const match of resultText(m).matchAll(NOTE_ID)) lastFailure = Math.max(lastFailure, Number(match[1]));
	}
	return { ids, lastFailure };
}

/** At before_agent_start the new prompt is not stored yet, so any user message means an earlier prompt. */
const hasPrompt = (entries: Entry[]): boolean => entries.some((e) => e?.type === "message" && e.message?.role === "user");

export function statusText(state: Pick<State, "enabled" | "inContext" | "counter" | "saved">): string | undefined {
	if (!state.enabled) return "off";
	const parts: string[] = [];
	if (state.inContext.size > 0) parts.push(`${state.inContext.size} in context`);
	if (state.counter > 0) parts.push(`${state.counter} nudged`);
	if (state.saved > 0) parts.push(`${state.saved} saved`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

const head = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const module: ToolkitModule = {
	id: ID,
	label: "Auto-learn from failures",
	description: "Failed tool calls get a one-line nudge to save a reusable, expiring repo lesson; lessons join the context once and are never rewritten",
	default: true,
	order: 40,
	child: ["researcher", "worker", "git", "test"],
	setup(pi: ExtensionAPI, kit: Toolkit) {
		if ((process.env.PI_TOOLKIT_LEARN ?? "").trim().toLowerCase() === "off") {
			kit.log(ID, "disabled by PI_TOOLKIT_LEARN=off");
			return;
		}
		const cfg = kit.config(ID, DEFAULTS);
		const store: StoreOptions = {
			dir: join(kit.paths.toolkitDir, "learn"),
			ttlMs: cfg.ttlDays * 86_400_000,
			maxPerRepo: cfg.maxPerRepo,
			maxLessonChars: cfg.maxLessonChars,
		};
		const state: State = {
			enabled: true,
			failures: new Map(),
			counter: 0,
			repo: undefined,
			active: new Map(),
			inContext: new Set(),
			saved: 0,
			compacted: false,
		};

		/** Start delivering a repo's lessons; true when it was not active yet. */
		const activate = (repo: RepoIdentity): boolean => {
			if (state.active.has(repo.key)) return false;
			state.active.set(repo.key, { repo, lessons: [], mtime: -1 });
			return true;
		};
		const sessionRepo = (ctx: { cwd?: string }): RepoIdentity => {
			state.repo ??= resolveRepo(ctx.cwd || process.cwd());
			activate(state.repo);
			return state.repo;
		};
		/** The git repos a call's paths are in, first-named first. */
		const reposOfCall = (toolName: string, input: Record<string, unknown> | undefined, cwd: string): RepoIdentity[] => {
			const out: RepoIdentity[] = [];
			for (const path of callPaths(toolName, input, cwd)) {
				const root = gitRootOf(path);
				if (!root) continue;
				const repo = resolveRepo(root);
				if (!out.some((r) => r.key === repo.key)) out.push(repo);
			}
			return out;
		};
		const failureById = (id: unknown): Failure | undefined => {
			const key = String(id ?? "").trim();
			for (const f of state.failures.values()) if (f.id === key) return f;
			return undefined;
		};
		/** Lessons not in context yet, per active repo; unchanged store files are skipped unless forced. */
		const pendingGroups = (force: boolean): Group[] => {
			const groups: Group[] = [];
			for (const active of state.active.values()) {
				const mtime = mtimeOf(lessonFile(store.dir, active.repo.key));
				if (force || mtime !== active.mtime) {
					active.mtime = mtime;
					active.lessons = loadLessons(store, active.repo.key, active.repo.label).lessons;
				}
				const lessons = active.lessons.filter((l) => !state.inContext.has(l.id));
				if (lessons.length > 0) groups.push({ active, lessons });
			}
			return groups;
		};
		const showStatus = (ctx: any): void => {
			if (kit.role.isChild || !ctx?.hasUI) return;
			try {
				ctx.ui.setStatus(STATUS_KEY, statusText(state));
			} catch {}
		};
		const rowLessons = (lessons: Lesson[]) => lessons.map((l) => ({ id: l.id, text: l.text, role: l.origin?.role ?? null }));
		const originOf = (ctx: { model?: { provider?: string; id?: string }; thinkingLevel?: string }): LessonOrigin => ({
			provider: ctx.model?.provider ?? null,
			model: ctx.model?.id ?? null,
			thinkingLevel: ctx.thinkingLevel ?? null,
			role: kit.role.role ?? (kit.role.isChild ? "child" : "main"),
		});

		pi.on("session_start", (_event, ctx) => {
			// A resumed or forked session already carries lessons and notes; count from them.
			const seen = scanContext(contextEntries(ctx));
			state.failures.clear();
			state.counter = seen.lastFailure;
			state.active.clear();
			state.inContext = seen.ids;
			state.saved = 0;
			state.compacted = false;
			showStatus(ctx);
		});

		// What the model can see changed wholesale: a compaction summarised old messages, or /tree moved the leaf.
		const rescan = (ctx: any): void => {
			const before = state.inContext;
			state.inContext = scanContext(contextEntries(ctx)).ids;
			if ([...before].some((id) => !state.inContext.has(id))) state.compacted = true;
			showStatus(ctx);
		};
		pi.on("session_compact", (_event, ctx) => rescan(ctx));
		pi.on("session_tree", (_event, ctx) => {
			rescan(ctx);
			state.compacted = false;
		});

		// 1. The session's first prompt takes every lesson; later prompts take what is new.
		pi.on("before_agent_start", (_event, ctx) => {
			try {
				if (!state.enabled) return undefined;
				sessionRepo(ctx);
				const groups = pendingGroups(true);
				if (groups.length === 0) return undefined;
				const trigger: InjectTrigger = state.compacted ? "compaction" : hasPrompt(contextEntries(ctx)) ? "prompt" : "start";
				const content = groups.map((g) => lessonsBlock(g.active.repo.label, g.lessons, cfg.ttlDays, trigger)).join("\n\n");
				const lessons = groups.flatMap((g) => g.lessons);
				for (const l of lessons) state.inContext.add(l.id);
				state.compacted = false;
				const details: InjectedData = { trigger, repo: groups.map((g) => g.active.repo.label).join(", "), lessons: rowLessons(lessons), tokens: estimateTokens(content) };
				kit.log(ID, `injected ${lessons.length} (${trigger})`);
				showStatus(ctx);
				return { message: { customType: LESSONS_TYPE, content, display: true, details } };
			} catch (error) {
				kit.log(ID, `before_agent_start: ${String(error)}`);
				return undefined;
			}
		});

		// 2. Failures get a note; new lessons and a touched repo's lessons ride on the result. Both are stored once.
		pi.on("tool_result", (event, ctx) => {
			try {
				if (!state.enabled) return undefined;
				const session = sessionRepo(ctx);
				const touched = reposOfCall(event.toolName, event.input, ctx.cwd || process.cwd());
				const arrived = new Set(touched.filter((r) => activate(r)).map((r) => r.key));
				const notes: string[] = [];

				const kind = classify(event);
				if (kind) {
					const failure: Failure = {
						id: `L${++state.counter}`,
						kind,
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						head: describeCall(event.toolName, event.input),
						error: textOf(event).slice(0, 300),
						repoKey: (touched[0] ?? session).key,
						handled: false,
					};
					state.failures.set(event.toolCallId, failure);
					while (state.failures.size > MAX_FAILURES) {
						const victim = [...state.failures.entries()].find(([, f]) => f.handled)?.[0] ?? state.failures.keys().next().value;
						if (victim === undefined) break;
						state.failures.delete(victim);
					}
					kit.log(ID, `${failure.id} ${kind} ${event.toolName}`);
					notes.push(guidance(failure));
				}

				// The learn result itself only confirms the save; the lesson rides on the next tool result.
				const delivered: string[] = [];
				if (!OWN_TOOLS.has(event.toolName)) {
					for (const group of pendingGroups(false)) {
						const trigger: InjectTrigger = state.compacted ? "compaction" : arrived.has(group.active.repo.key) ? "repo" : "turn";
						const block = lessonsBlock(group.active.repo.label, group.lessons, cfg.ttlDays, trigger);
						notes.push(block);
						for (const l of group.lessons) {
							state.inContext.add(l.id);
							delivered.push(l.id);
						}
						kit.log(ID, `injected ${group.lessons.length} (${trigger}) into ${event.toolName}`);
						if (ctx.hasUI && !kit.role.isChild) {
							const data: InjectedData & { kind: string } = { kind: "injected", trigger, repo: group.active.repo.label, lessons: rowLessons(group.lessons), tokens: estimateTokens(block) };
							pi.appendEntry(CUSTOM_TYPE, data);
						}
					}
					if (delivered.length > 0) state.compacted = false;
				}

				if (notes.length === 0) return undefined;
				showStatus(ctx);
				let content: Content = event.content as Content;
				for (const note of notes) content = withNote(content, note);
				if (delivered.length === 0) return { content: content as typeof event.content };
				const base = event.details && typeof event.details === "object" ? (event.details as Record<string, unknown>) : {};
				return { content: content as typeof event.content, details: { ...base, [DETAILS_KEY]: { lessons: delivered } } as typeof event.details };
			} catch (error) {
				kit.log(ID, `tool_result: ${String(error)}`);
				return undefined;
			}
		});

		// 3. The learn tool.
		pi.registerTool({
			name: "learn",
			label: "Learn",
			description:
				"Save one verified, reusable correction after a failed tool call: its cause and what to do next time (tool usage, command syntax, environment, test setup). failureId is the L<n> from the [auto-learn] note. To revise or merge related lessons use action \"replace\" with replaces=[their exact texts]. Never save secrets or raw output.",
			parameters: Type.Object({
				failureId: Type.String({ description: "L<n> from the [auto-learn] note" }),
				lesson: Type.String({ description: "One concrete sentence: the cause and what to do next time" }),
				action: Type.Optional(StringEnum(["add", "replace"] as const, { description: "add (default) or replace" })),
				replaces: Type.Optional(Type.Array(Type.String(), { description: "Exact texts of existing lessons to replace" })),
				repo: Type.Optional(Type.String({ description: "Repo key or label when not the failure's repo" })),
			}),
			renderShell: "self",
			async execute(_toolCallId, params: LearnParams, _signal, _onUpdate, ctx) {
				const failure = failureById(params.failureId);
				if (!failure) {
					throw new Error(`Unknown failureId "${params.failureId ?? ""}". Use the L<n> id from the [auto-learn] note of the failed call; ids are session-local.`);
				}
				if (failure.handled) {
					const details: LearnDetails = { status: "handled", repo: findRepo(failure.repoKey)?.label ?? failure.repoKey, lesson: "" };
					return { content: [{ type: "text", text: `${failure.id} is already handled; nothing saved.` }], details };
				}
				const repo = params.repo ? findRepo(params.repo) : (findRepo(failure.repoKey) ?? sessionRepo(ctx));
				if (!repo) {
					throw new Error(`Unknown repo "${params.repo}". Known: ${knownRepos().map((r) => `${r.key} (${r.label})`).join(", ") || "none"}`);
				}
				const result = await saveLesson(store, repo.key, {
					text: params.lesson,
					repoLabel: repo.label,
					origin: originOf(ctx),
					action: params.action,
					replaces: params.replaces,
				});
				if (result.status === "similar") {
					// Not handled: the model may still replace the existing lesson with a better one.
					const details: LearnDetails = { status: "similar", repo: repo.label, lesson: result.lesson.text, id: result.lesson.id };
					const text = `Not saved: ${repo.label} already has a similar lesson: "${result.lesson.text}". If yours corrects or extends it, call learn again with action "replace" and replaces ["<that exact text>"]; otherwise leave it.`;
					return { content: [{ type: "text", text }], details };
				}
				failure.handled = true;
				activate(repo);
				const active = state.active.get(repo.key);
				if (active) {
					active.lessons = result.lessons;
					active.mtime = mtimeOf(lessonFile(store.dir, repo.key));
				}
				if (result.status !== "duplicate") {
					state.saved++;
					if (ctx.hasUI && !kit.role.isChild) pi.appendEntry(CUSTOM_TYPE, { kind: result.status === "replaced" ? "updated" : "learned", repo: repo.label, lesson: result.lesson.text });
				}
				showStatus(ctx);
				const expires = `expires in ${formatExpiry(result.lesson.expiresAt)}`;
				const text =
					result.status === "duplicate"
						? "Already known; nothing changed."
						: result.status === "replaced"
							? `Updated (${repo.label}): replaced ${result.removed.length}; ${expires}.`
							: `Learned (${repo.label}); ${expires}.`;
				const details: LearnDetails = {
					status: result.status,
					repo: repo.label,
					lesson: result.lesson.text,
					id: result.lesson.id,
					expiresAt: result.lesson.expiresAt,
					removed: result.removed.length,
					dropped: result.dropped.length,
				};
				return { content: [{ type: "text", text }], details };
			},
			renderCall(args: Partial<LearnParams>, theme, context) {
				const row = context.state as LearnRowState;
				const frameState: FrameState = row.done ? (row.error ? "error" : "ok") : "running";
				const failure = failureById(args?.failureId);
				const label = (failure && (findRepo(failure.repoKey)?.label ?? failure.repoKey)) || args?.repo || state.repo?.label || String(args?.failureId ?? "");
				const last = context.lastComponent;
				const top = last instanceof FrameTop ? last.update("LEARN", [label], frameState) : new FrameTop("LEARN", [label], frameState, theme);
				const collapsed = row.done && !context.expanded;
				top.hidden = !!(collapsed && row.saved);
				top.summary = collapsed && !row.saved ? row.summary : undefined;
				row.top = top;
				row.label = label;
				return top;
			},
			renderResult(result, { expanded }, theme, context) {
				const row = context.state as LearnRowState;
				const details = result.details as LearnDetails | undefined;
				row.done = true;
				row.error = !!context.isError;
				// A saved lesson has its own ◆ LEARNED row, so the finished tool row disappears.
				row.saved = !row.error && (details?.status === "added" || details?.status === "replaced");
				const stats = row.error || !details ? [toLines(resultText(result))[0] ?? "error"] : [STATUS_LABEL[details.status] ?? details.status];
				row.summary = summaryLine("learn", shortRepo(row.label ?? ""), stats, row.error ? "error" : "ok", theme);
				if (row.top) {
					row.top.state = row.error ? "error" : "ok";
					row.top.hidden = !expanded && row.saved;
					row.top.summary = !expanded && !row.saved ? row.summary : undefined;
				}
				if (!row.invalidated) {
					row.invalidated = true;
					// Deferred: a synchronous invalidate re-enters pi's row update mid-render.
					queueMicrotask(() => {
						try {
							context.invalidate();
						} catch {}
					});
				}
				let lines: string[];
				if (context.isError || !details) lines = toLines(resultText(result));
				else if (details.status === "added" || details.status === "replaced") lines = [`${details.status === "replaced" ? "updated" : "learned"}: ${details.lesson}`];
				else lines = [STATUS_LABEL[details.status] ?? details.status];
				const last = context.lastComponent;
				const bottom = last instanceof FrameBottom ? last.update({ lines, expanded }) : new FrameBottom({ lines, expanded }, theme);
				bottom.hidden = !expanded;
				return bottom;
			},
		} as Parameters<ExtensionAPI["registerTool"]>[0]);

		// 4. TUI rows (display only).
		pi.registerEntryRenderer(CUSTOM_TYPE, (entry, options, theme) => {
			const data = (entry?.data ?? {}) as any;
			return data.kind === "injected" ? injectedRow(data, options.expanded, theme) : learnedRow(data, options.expanded, theme);
		});
		pi.registerMessageRenderer<InjectedData>(LESSONS_TYPE, (message, options, theme) => injectedRow(message.details, options.expanded, theme));

		if (kit.role.isChild) return;

		pi.registerCommand("learn", {
			description: "Auto-learn: lessons for this repo (/learn, /learn forget <n>, /learn on|off)",
			getArgumentCompletions: (prefix) => {
				const items = ["forget", "on", "off"].filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
				return items.length ? items : null;
			},
			handler: async (args, ctx) => {
				try {
					const [sub, arg] = (args ?? "").trim().split(/\s+/);
					const repo = sessionRepo(ctx);
					const active = state.active.get(repo.key);
					if (sub === "on" || sub === "off") {
						state.enabled = sub === "on";
						showStatus(ctx);
						ctx.ui.notify(`auto-learn ${sub} for this session`, "info");
						return;
					}
					if (sub === "forget") {
						const n = Number.parseInt(arg ?? "", 10);
						if (!Number.isFinite(n) || n < 1) {
							ctx.ui.notify("usage: /learn forget <n>", "error");
							return;
						}
						const { removed, lessons } = await forgetLesson(store, repo.key, n - 1, repo.label);
						if (active) active.lessons = lessons;
						ctx.ui.notify(removed ? `forgot: ${head(removed.text, 80)}` : `no lesson #${n}`, removed ? "info" : "error");
						return;
					}
					const { lessons } = loadLessons(store, repo.key, repo.label);
					if (active) active.lessons = lessons;
					const now = Date.now();
					const lines = lessons.map((l, i) => `${i + 1}. ${l.text}  (expires in ${formatExpiry(l.expiresAt, now)})`);
					if (lines.length === 0) lines.push("no lessons for this repo yet");
					const status = `${lessons.length} lesson${lessons.length === 1 ? "" : "s"} · ${state.enabled ? "on" : "off"} · ${cfg.ttlDays}-day expiry · /learn forget <n>`;
					kit.print("learn", [repo.label, status], lines, "ok");
				} catch (error) {
					ctx.ui.notify(`auto-learn: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	},
};

interface LearnRowState extends FrameRowState {
	top?: FrameTop;
	summary?: string;
	label?: string;
	/** The call saved a lesson (added or replaced). */
	saved?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
	duplicate: "already known",
	handled: "already handled",
	similar: "not saved: a similar lesson exists",
};

export default module;
