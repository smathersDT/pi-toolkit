/**
 * What the subagent module does inside a child process: enforce the caps the
 * parent passed in the environment and the role's tool gate. Nothing is added
 * to the prompt here — the parent already appended the role prompt.
 *
 *   turns    steer at maxTurns − 1 ("give your final report now"), block tool
 *            calls from maxTurns on
 *   tokens   steer at 85 % of maxTokens (not on the final message: a steer
 *            starts another turn that replaces the report), block at 100 %
 *   gates    git → read-only git only; test → test runners and checks only;
 *            worker → edits and shell writes inside ownedFiles only. From the
 *            second block on, the reason tells the child to stop and report
 *            (a test child once spent its whole turn budget on workarounds).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Toolkit } from "../../core/kit.ts";
import { checkGate, parseAllow } from "./gates.ts";
import { callsTools, usageTokens } from "./usage.ts";

export const TURN_CAP_STEER = "Turn budget nearly exhausted: give your final report now, with what you have.";
export const TOKEN_CAP_STEER = "Token budget nearly exhausted: give your final report now, with what you have.";
export const GATE_STOP = "Blocked again: stop trying other commands and write your final report now, saying what you could not run and why.";
/** Three researchers kept calling tools past the token block and were killed with no report. */
export const BUDGET_STOP = "call no more tools; write your final report now with what you have, or the run is killed with nothing to show.";

export function parseOwnedFiles(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
	} catch {
		return [];
	}
}

export function setupChild(pi: ExtensionAPI, kit: Toolkit, env: NodeJS.ProcessEnv = process.env): void {
	const role = kit.role.role;
	const maxTurns = kit.role.maxTurns;
	const maxTokens = kit.role.maxTokens;
	const ownedFiles = parseOwnedFiles(env.PI_TOOLKIT_OWNED_FILES);
	const allow = parseAllow(env.PI_TOOLKIT_ALLOW);
	let blocks = 0;
	let turns = 0;
	let tokens = 0;
	let turnSteered = false;
	let tokenSteered = false;

	const steer = (text: string) => {
		try {
			pi.sendMessage({ customType: "toolkit-cap", content: text, display: false }, { deliverAs: "steer" });
		} catch (error) {
			kit.log("subagent", `steer failed: ${String(error)}`);
		}
	};

	pi.on("turn_start", () => {
		turns++;
		if (maxTurns && !turnSteered && turns >= maxTurns - 1) {
			turnSteered = true;
			steer(TURN_CAP_STEER);
		}
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; usage?: unknown; stopReason?: unknown; content?: unknown } | undefined;
		if (!message || message.role !== "assistant" || !message.usage) return;
		tokens += usageTokens(message.usage);
		if (maxTokens && !tokenSteered && tokens >= maxTokens * 0.85 && callsTools(message)) {
			tokenSteered = true;
			steer(TOKEN_CAP_STEER);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		try {
			if (maxTurns && turns >= maxTurns) return { block: true, reason: `turn budget exhausted — ${BUDGET_STOP}` };
			if (maxTokens && tokens >= maxTokens) return { block: true, reason: `token budget exhausted — ${BUDGET_STOP}` };
			const gate = checkGate(event.toolName, event.input, { role, ownedFiles, cwd: ctx.cwd, allow });
			if (gate && ++blocks >= 2) return { block: true, reason: `${gate.reason}. ${GATE_STOP}` };
			return gate;
		} catch (error) {
			kit.log("subagent", `gate error: ${String(error)}`);
			return undefined;
		}
	});
}
