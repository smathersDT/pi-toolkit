/**
 * Context compaction: makes tool results and pasted prompts as small as
 * possible while staying lossless, or clearly marking what was removed and
 * where the full text lives. See output.ts and input.ts for the passes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { fmtBytes, fmtTokens, type LedgerRow } from "../../core/ledger.ts";
import { compactInput } from "./input.ts";
import { compactOutput, DEFAULT_CAPS, type CompactCaps } from "./output.ts";
import { foldValidationMessages, type EchoMessage } from "./validation.ts";

export interface CompactConfig {
	caps: CompactCaps;
	guidance: boolean;
	spillDays: number;
	toon: boolean;
	maskLogs: boolean;
	input: boolean;
	echo: boolean;
}

export const DEFAULTS: CompactConfig = {
	caps: DEFAULT_CAPS,
	guidance: true,
	/** Days a spill file is kept before the next session start sweeps it. */
	spillDays: 3,
	toon: true,
	maskLogs: true,
	input: true,
	/** Drop the argument echo from tool-call validation failures (validation.ts). */
	echo: true,
};

/** Stable text, appended every turn so it stays in the cached prefix. Under 60 words. */
export const GUIDANCE =
	"Tool results are compacted: `[+N identical/similar lines]` marks folded runs, `§1` tokens expand via the `[legend: …]` line, and capped output names a spill file holding the full text. " +
	"Shape commands for small output (--oneline, --porcelain, --name-only, -q, head/grep) and read files with offset/limit.";

const LEDGER_ROWS = ["compact", "compact:input", "compact:echo"];

function formatRow(id: string, row: LedgerRow): string {
	const saved = row.before - row.after;
	const pct = row.before > 0 ? Math.round((saved / row.before) * 100) : 0;
	return `${id.padEnd(14)} ${String(row.count).padStart(4)}×  ${fmtBytes(row.before).padStart(8)} → ${fmtBytes(row.after).padStart(8)}  (-${pct}%, ~${fmtTokens(saved)} tokens)`;
}

function showLedger(kit: Toolkit): void {
	const rows = kit.ledger.entries().filter(([id]) => LEDGER_ROWS.includes(id));
	const lines = rows.length > 0 ? rows.map(([id, row]) => formatRow(id, row)) : ["nothing recorded yet this session"];
	kit.print("compact", ["bytes removed from tool results and prompts this session"], lines, "ok");
}

const module: ToolkitModule = {
	id: "compact",
	label: "Context compaction",
	description: "Folds, masks and caps tool output and pasted prompts; full text spills to a file",
	default: true,
	order: 30,
	child: "always",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const cfg = kit.config("compact", DEFAULTS);
		const spillDir = join(kit.paths.toolkitDir, "spill");
		const truncators = { head: truncateHead, tail: truncateTail };

		// Spill files are only useful for the session that wrote them; sweep old ones.
		/** Validation failures already booked: the context hook folds them again on every request. */
		const echoesBooked = new Set<string>();

		pi.on("session_start", () => {
			echoesBooked.clear();
			try {
				if (!existsSync(spillDir)) return;
				const cutoff = Date.now() - cfg.spillDays * 24 * 3600 * 1000;
				for (const name of readdirSync(spillDir)) {
					const file = join(spillDir, name);
					try {
						if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
					} catch {}
				}
			} catch (error) {
				kit.log("compact", `spill sweep: ${String(error)}`);
			}
		});

		pi.on("tool_result", (event) => {
			try {
				const details = event.details as { keepalive?: { running?: boolean; tool?: unknown } } | undefined;
				if (details?.keepalive?.running) return undefined;
				// A job collected through `wait` is still the tool that started it: a bash
				// build keeps its tail, where the verdict is, not wait's default head.
				const toolName = typeof details?.keepalive?.tool === "string" ? details.keepalive.tool : event.toolName;
				const content = Array.isArray(event.content) ? event.content : [];
				const textBlocks = content.filter((b) => b.type === "text" && typeof (b as { text?: unknown }).text === "string") as Array<{ type: "text"; text: string }>;
				if (textBlocks.length === 0) return undefined;
				const text = textBlocks.map((b) => b.text).join("\n");
				const result = compactOutput(
					{ toolName, toolCallId: event.toolCallId, input: event.input as Record<string, unknown> | undefined, text, isError: !!event.isError },
					cfg,
					truncators,
					spillDir,
				);
				kit.ledger.add("compact", result.before, result.after);
				if (result.text === text) return undefined;
				const rest = content.filter((b) => b.type !== "text");
				return { content: [{ type: "text" as const, text: result.text }, ...rest] };
			} catch (error) {
				kit.log("compact", `tool_result: ${String(error)}`);
				return undefined;
			}
		});

		if (cfg.echo) {
			pi.on("context", (event) => {
				try {
					const r = foldValidationMessages(event.messages as unknown as EchoMessage[]);
					if (!r) return undefined;
					for (const f of r.folded) {
						if (echoesBooked.has(f.toolCallId)) continue;
						echoesBooked.add(f.toolCallId);
						kit.ledger.add("compact:echo", f.before, f.after);
					}
					return { messages: r.messages as unknown as typeof event.messages };
				} catch (error) {
					kit.log("compact", `context: ${String(error)}`);
					return undefined;
				}
			});
		}

		if (cfg.input) {
			pi.on("input", (event) => {
				try {
					if (event.source !== "interactive") return undefined;
					const result = compactInput(event.text, { toon: cfg.toon });
					if (!result) return undefined;
					kit.ledger.add("compact:input", result.before, result.after);
					return { action: "transform" as const, text: result.text };
				} catch (error) {
					kit.log("compact", `input: ${String(error)}`);
					return undefined;
				}
			});
		}

		if (cfg.guidance) {
			pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` }));
		}

		// pi owns /compact (context summarisation), so the ledger gets its own name.
		pi.registerCommand("compact-stats", {
			description: "Show bytes the compact module removed this session",
			handler: async () => showLedger(kit),
		});
	},
};

export default module;
