/**
 * Spawn a child pi in `--mode json` and fold its event stream into a report:
 * turns, usage, the last assistant text, one-line progress. The parent-side
 * caps (turns, tokens, wall clock, abort) kill the process tree.
 *
 * `buildChildCommand` is pure; `runChild` takes any command so tests drive it
 * with a fake child script that prints JSON lines.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { addUsage, callsTools, emptyUsage, type UsageSum, usageTokens } from "./usage.ts";

export interface ChildSpec {
	/** pi's cli.js; defaults to process.argv[1] (the running pi). */
	cliPath?: string;
	/** node; defaults to process.execPath. */
	nodePath?: string;
	/** The toolkit's index.ts, loaded as the only extension. */
	extensionEntry: string;
	cwd: string;
	role: string;
	task: string;
	/** provider/id */
	model: string;
	thinking: string;
	tools: string[];
	appendSystemPrompt: string;
	depth: number;
	maxTurns: number;
	/** 0 = no token cap. */
	maxTokens: number;
	ownedFiles?: string[];
	/** The role's `allow` regex sources for the git/test gate. */
	allow?: string[];
}

export interface ChildCommand {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

export function buildChildCommand(spec: ChildSpec, baseEnv: NodeJS.ProcessEnv = process.env): ChildCommand {
	const cli = spec.cliPath ?? process.argv[1];
	const args = [
		cli,
		"--mode", "json",
		"-p",
		"--no-extensions",
		"-e", spec.extensionEntry,
		"--no-session",
		"--no-skills",
		"--no-prompt-templates",
		"--model", spec.model,
		"--thinking", spec.thinking,
		"--tools", spec.tools.join(","),
		"--append-system-prompt", spec.appendSystemPrompt,
		"--",
		spec.task,
	];
	const env: NodeJS.ProcessEnv = {
		...baseEnv,
		PI_TOOLKIT_ROLE: spec.role,
		PI_TOOLKIT_DEPTH: String(spec.depth),
		PI_TOOLKIT_MAX_TURNS: String(spec.maxTurns),
		PI_TOOLKIT_MAX_TOKENS: String(spec.maxTokens),
		PI_TOOLKIT_OWNED_FILES: JSON.stringify(spec.ownedFiles ?? []),
		PI_TOOLKIT_ALLOW: JSON.stringify(spec.allow ?? []),
	};
	return { command: spec.nodePath ?? process.execPath, args, env };
}

export interface RunOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	maxTurns: number;
	/** 0 = no token cap. */
	maxTokens: number;
	timeoutSec: number;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
	stderrTailBytes?: number;
}

export interface RunOutcome {
	/** The last assistant text: the report. Empty when the child said nothing. */
	report: string;
	turns: number;
	usage: UsageSum;
	durationMs: number;
	exitCode: number | null;
	/** The last assistant stopReason, or "killed". */
	stopReason: string;
	/** Why the parent killed it, when it did. */
	killed?: string;
	stderrTail: string;
	/** The child's error message when its last message was an error. */
	errorMessage?: string;
}

function textOfMessage(message: { content?: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

function describeTool(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = (key: string): string => (typeof a[key] === "string" ? (a[key] as string) : "");
	const detail = (pick("command") || pick("path") || pick("pattern") || pick("query") || pick("url") || pick("task") || "").replace(/\s+/g, " ").trim();
	return detail ? `${name} ${detail.length > 100 ? `${detail.slice(0, 99)}…` : detail}` : name;
}

export function killProcessTree(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			killer.on("error", () => child.kill("SIGKILL"));
		} catch {
			child.kill("SIGKILL");
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

/** Run the child and fold its JSON event stream. Rejects only when the child failed without saying anything. */
export function runChild(opts: RunOptions): Promise<RunOutcome> {
	return new Promise<RunOutcome>((resolvePromise, rejectPromise) => {
		const startedAt = Date.now();
		const tailBytes = opts.stderrTailBytes ?? 2048;
		let turns = 0;
		const usage = emptyUsage();
		let report = "";
		let stopReason = "unknown";
		let errorMessage: string | undefined;
		let killed: string | undefined;
		let stderr = "";
		let settled = false;
		let linesClosed = false;
		let exitCode: number | null | undefined;
		let runningTool = "";
		let lastTool = "";

		let child: ChildProcess;
		try {
			child = spawn(opts.command, opts.args, {
				cwd: opts.cwd,
				env: opts.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			});
		} catch (error) {
			rejectPromise(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const progress = (line: string) => {
			try {
				opts.onProgress?.(line);
			} catch {}
		};
		const kill = (reason: string) => {
			if (killed) return;
			killed = reason;
			progress(`killed: ${reason}`);
			killProcessTree(child);
		};
		const timer = setTimeout(() => kill(`timeout after ${opts.timeoutSec}s`), Math.max(1, opts.timeoutSec) * 1000);
		(timer as { unref?: () => void }).unref?.();
		const onAbort = () => kill("aborted");
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });

		const cleanup = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		const finish = () => {
			if (settled || !linesClosed || exitCode === undefined) return;
			settled = true;
			cleanup();
			const durationMs = Date.now() - startedAt;
			const outcome: RunOutcome = {
				report,
				turns,
				usage,
				durationMs,
				exitCode,
				stopReason: killed ? "killed" : stopReason,
				killed,
				stderrTail: stderr,
				errorMessage,
			};
			if (!killed && exitCode !== 0 && !report.trim()) {
				const why = errorMessage ?? (stderr.trim() ? stderr.trim() : "no output");
				rejectPromise(Object.assign(new Error(`child exited with code ${exitCode}: ${why.slice(-1500)}`), { outcome }));
				return;
			}
			if (!killed && stopReason === "error" && !report.trim()) {
				rejectPromise(Object.assign(new Error(`child failed: ${errorMessage ?? "unknown error"}`), { outcome }));
				return;
			}
			resolvePromise(outcome);
		};

		const handle = (ev: Record<string, unknown>) => {
			switch (ev.type) {
				case "turn_start": {
					turns++;
					progress(lastTool ? `turn ${turns} · last: ${lastTool}` : `turn ${turns}`);
					if (turns > opts.maxTurns + 2) kill(`turn cap (${turns} > ${opts.maxTurns} + 2)`);
					break;
				}
				case "message_end": {
					const message = ev.message as { role?: string; usage?: unknown; content?: unknown; stopReason?: string; errorMessage?: string } | undefined;
					if (!message || message.role !== "assistant") break;
					addUsage(usage, message.usage);
					const text = textOfMessage(message);
					if (text.trim()) report = text;
					if (typeof message.stopReason === "string") stopReason = message.stopReason;
					if (typeof message.errorMessage === "string") errorMessage = message.errorMessage;
					// Never kill the final report. Past the cap the child still needs a blocked
					// turn and a report turn, so the line sits two turns of this size beyond it
					// (within 120–200 % of the cap).
					if (opts.maxTokens > 0 && callsTools(message)) {
						const total = usageTokens(usage);
						const twoTurns = opts.maxTokens + 2 * usageTokens(message.usage);
						const line = Math.min(2 * opts.maxTokens, Math.max(Math.round(opts.maxTokens * 1.2), twoTurns));
						if (total > line) kill(`token cap (${total} > ${line})`);
					}
					break;
				}
				case "tool_execution_start":
					runningTool = describeTool(String(ev.toolName ?? "tool"), ev.args);
					progress(`turn ${turns} · ${runningTool}`);
					break;
				case "tool_execution_end":
					// Keep the command on screen: the next turn_start would otherwise wipe it at once.
					lastTool = `${runningTool || String(ev.toolName ?? "tool")} ${ev.isError === true ? "✗" : "✓"}`;
					runningTool = "";
					progress(`turn ${turns} · ${lastTool}`);
					break;
				default:
					break;
			}
		};

		const rl = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) return;
			try {
				const ev = JSON.parse(trimmed) as Record<string, unknown>;
				if (ev && typeof ev === "object") handle(ev);
			} catch {}
		});
		rl.on("close", () => {
			linesClosed = true;
			finish();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = (stderr + chunk.toString()).slice(-tailBytes);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(error);
		});
		child.on("close", (code) => {
			exitCode = code;
			finish();
		});
	});
}
