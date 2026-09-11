/**
 * Permission gate — a Claude-Code-style approval prompt in front of every
 * bash, write and edit call, judged before any other module rewrites it.
 *
 * One global rules file, `<agent-dir>/toolkit/permissions.json`:
 *
 *   { "mode": "block", "workspaces": [], "allow": [], "deny": [], "askOnce": true }
 *
 *   guard   refuse the block tier, ask on the confirm tier, silent otherwise
 *   strict  refuse both tiers, never ask
 *   yolo    allow everything (deny rules still apply), log only
 *
 * The dialog offers Allow once / Allow always / Deny; "always" saves a
 * `Bash(<first two words>:*)` or `Write(<dir>/**)` rule. Children inherit the
 * file and, having no dialog, get confirm-tier calls refused. Every refusal
 * reaches the model as `[permissions] …` (the auto-learn module keys on it).
 *
 *   /permissions                    show mode, workspaces, rules, file path
 *   /permissions mode block|guard|strict|yolo
 *   /permissions add <workspace>    a directory writable without a dialog
 *   /permissions allow <pattern>    /permissions deny <pattern>
 *
 * Settings: `"permissions": { "logDecisions": false }` — notify every non-silent decision.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { homedir, tmpdir } from "node:os";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { canon, resolvePath } from "./paths.ts";
import { decide, ruleFor, subjectOf, type PermissionRules } from "./rules.ts";
import { createRulesStore, MODES, type RulesStore } from "./store.ts";

const DEFAULTS = { logDecisions: false };
const ONCE = "Allow once";
const ALWAYS = "Allow always (save rule)";
const DENY = "Deny";
const ADVICE = "Do not retry or work around this; ask the user instead.";

interface GateContext {
	kit: Toolkit;
	store: RulesStore;
	cfg: typeof DEFAULTS;
	/** "Allow once" decisions for this session, when askOnce is on. */
	cache: Set<string>;
}

const module: ToolkitModule = {
	id: "permissions",
	label: "Permission gate",
	description: "Refuse destructive commands, ask before risky ones (/permissions)",
	default: true,
	order: 10,
	child: "always",
	setup(pi, kit) {
		const gate: GateContext = { kit, store: createRulesStore(), cfg: kit.config("permissions", DEFAULTS), cache: new Set() };
		try {
			gate.store.get(); // create the file with defaults on first run
		} catch (error) {
			kit.log("permissions", `rules file: ${String(error)}`);
		}

		pi.on("tool_call", async (event, ctx) => {
			try {
				return await judge(gate, event, ctx);
			} catch (error) {
				kit.log("permissions", `gate error, letting the call through: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		});

		if (!kit.role.isChild) registerCommand(pi, gate);
	},
};
export default module;

/** Roots writable without a dialog: cwd (implied), configured workspaces, temp dir, toolkit dir, the scratchpad. */
function writableRoots(rules: PermissionRules, kit: Toolkit): string[] {
	const roots = [...rules.workspaces, tmpdir(), kit.paths.toolkitDir];
	const scratch = process.env.PI_SCRATCHPAD_DIR?.trim();
	if (scratch) roots.push(scratch);
	return roots;
}

function shorten(text: string, max = 70): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

async function judge(gate: GateContext, event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
	const { kit, store, cfg, cache } = gate;
	const rules = store.get();
	const input = (event.input ?? {}) as Record<string, unknown>;
	const decision = decide({
		tool: event.toolName,
		input,
		cwd: ctx.cwd,
		workspaces: writableRoots(rules, kit),
		rules,
		isChild: kit.role.isChild,
		hasUI: ctx.hasUI,
	});
	const subject = subjectOf(event.toolName, input) ?? "";
	const note = (text: string) => {
		kit.log("permissions", `${event.toolName}: ${text}`);
		if (cfg.logDecisions && ctx.hasUI) ctx.ui.notify(`[permissions] ${text}`, "info");
	};

	if (decision.verdict === "allow") {
		if (decision.reason) note(`${decision.reason} — ${shorten(subject)}`);
		return undefined;
	}
	if (decision.verdict === "deny") {
		note(`${decision.reason} — ${shorten(subject)}`);
		return { block: true, reason: `${decision.reason}. ${ADVICE}` };
	}

	// confirm tier in guard mode with a dialog available
	const key = `${event.toolName}\n${subject}`;
	if (rules.askOnce && cache.has(key)) {
		note(`allowed again (asked earlier this session) — ${shorten(subject)}`);
		return undefined;
	}
	if (!ctx.hasUI) return { block: true, reason: `[permissions] refused: ${decision.reason} needs confirmation and this session has no UI (${rules.mode} mode). ${ADVICE}` };

	const title = `Allow ${event.toolName} "${shorten(subject)}"? ${decision.reason}`;
	const choice = await ctx.ui.select(title, [ONCE, ALWAYS, DENY]);
	if (choice === ONCE) {
		if (rules.askOnce) cache.add(key);
		note(`allowed once by user — ${shorten(subject)}`);
		return undefined;
	}
	if (choice === ALWAYS) {
		const rule = ruleFor(event.toolName, subject, ctx.cwd);
		store.update((r) => {
			if (!r.allow.includes(rule)) r.allow.push(rule);
		});
		cache.add(key);
		ctx.ui.notify(`[permissions] saved allow rule ${rule} → ${store.path}`, "info");
		return undefined;
	}
	note(`denied by user — ${shorten(subject)}`);
	return { block: true, reason: `[permissions] denied by user. ${ADVICE}` };
}

/* ------------------------------------------------------------------------ */
/* /permissions                                                             */
/* ------------------------------------------------------------------------ */

function registerCommand(pi: ExtensionAPI, gate: GateContext): void {
	const { kit, store } = gate;
	pi.registerCommand("permissions", {
		description: "Permission gate: /permissions [mode block|guard|strict|yolo | add <dir> | allow <pattern> | deny <pattern>]",
		getArgumentCompletions: (prefix) => {
			const words = ["mode", "add", "allow", "deny"];
			const [head, tail] = prefix.split(/\s+/, 2);
			if (head === "mode" && tail !== undefined) {
				const items = MODES.filter((m) => m.startsWith(tail)).map((m) => ({ value: `mode ${m}`, label: `mode ${m}` }));
				return items.length ? items : null;
			}
			const items = words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ").trim();
			switch (sub) {
				case undefined:
					return show(gate);
				case "mode": {
					if (!MODES.includes(value as (typeof MODES)[number])) {
						ctx.ui.notify(`Usage: /permissions mode ${MODES.join("|")}`, "error");
						return;
					}
					store.update((r) => {
						r.mode = value as (typeof MODES)[number];
					});
					ctx.ui.notify(`[permissions] mode ${value}`, "info");
					return;
				}
				case "add": {
					if (!value) return usage(ctx);
					const dir = resolvePath(value, ctx.cwd, homedir(), { literal: true })?.path ?? canon(value);
					store.update((r) => {
						if (!r.workspaces.some((w) => canon(w) === dir)) r.workspaces.push(dir);
					});
					ctx.ui.notify(`[permissions] workspace added: ${dir}`, "info");
					return;
				}
				case "allow":
				case "deny": {
					if (!value) return usage(ctx);
					store.update((r) => {
						if (!r[sub].includes(value)) r[sub].push(value);
					});
					ctx.ui.notify(`[permissions] ${sub} rule added: ${value}`, "info");
					return;
				}
				default:
					return usage(ctx);
			}
		},
	});

	function usage(ctx: ExtensionCommandContext): void {
		ctx.ui.notify("Usage: /permissions [mode block|guard|strict|yolo | add <dir> | allow <pattern> | deny <pattern>]", "error");
	}

	function show(g: GateContext): void {
		const r = g.store.get();
		const head = [`mode ${r.mode} · ${r.workspaces.length} workspaces · ${r.allow.length} allow · ${r.deny.length} deny · askOnce ${r.askOnce ? "on" : "off"}`];
		const lines = [`file        ${g.store.path}`, "workspaces  cwd, temp dir and the toolkit dir are always writable"];
		for (const w of r.workspaces) lines.push(`            ${w}`);
		for (const a of r.allow) lines.push(`allow       ${a}`);
		for (const d of r.deny) lines.push(`deny        ${d}`);
		lines.push("tiers       block: rm -rf / ~ workspace, disk/power tools, curl|sh, force-push main, profiles/.ssh/hooks/system dirs …");
		lines.push("            confirm: git reset --hard/clean -f/branch -D, rm -rf <dir>, sudo, DROP TABLE, writes outside a workspace …");
		kit.print("permissions", head, lines);
	}
}
