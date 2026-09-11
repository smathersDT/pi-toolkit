/**
 * prune — drops what every request re-reads and this box never uses.
 *
 * Two surfaces are billed on every turn: the system prompt text, and the
 * active tools' schemas that travel beside it.
 *
 * 1. pi's core prompt ends with a nine-line "Pi documentation" section — paths
 *    plus a topic-to-filename routing table, ~300 tokens, unconditional. Outside
 *    a session that develops pi it is collapsed to one line that keeps the docs
 *    path and the ask-first guard. Inside a pi project (the agent dir, or a
 *    package depending on pi) the full section stays. `PI_TOOLKIT_PRUNE_DOCS`
 *    forces either answer. The rewrite is a pure function of cwd, so the prefix
 *    is byte-identical on every turn and cached once.
 *
 * 2. `find` and `ls` were measured at zero calls over hundreds of requests —
 *    the model reaches for `bash` regardless — yet their schemas ride in every
 *    request. They are held out of the active set at session start, main
 *    session only: a subagent child runs with the tool list its agent declared.
 *
 * Failure mode is "change nothing": a prompt whose anchors moved is returned
 * identity-equal, and only tool names actually registered are removed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { collapseDocsSection, forcedCollapse, isPiProject } from "./collapse.ts";

const DEFAULTS = { docs: true, dropTools: ["find", "ls"] as string[] };

const module: ToolkitModule = {
	id: "prune",
	label: "Prompt pruning",
	description: "Collapse pi's docs section outside pi projects; hold unused built-in tools out of every request",
	default: true,
	order: 20,
	child: "always",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const cfg = kit.config("prune", DEFAULTS);
		/** Resolved once per cwd: the check walks the tree to the filesystem root. */
		let decision: { cwd: string; collapse: boolean } | undefined;
		/** Characters the collapse removed — 0 until the first prompt build, and in a pi project. */
		let removedChars = 0;
		/** Tool names actually held back this session, for `/prune` to report. */
		let dropped: string[] = [];

		const shouldCollapse = (cwd: string): boolean => {
			if (!decision || decision.cwd !== cwd) {
				const collapse = cfg.docs !== false && (forcedCollapse() ?? !isPiProject(cwd, kit.paths.agentDir));
				decision = { cwd, collapse };
			}
			return decision.collapse;
		};

		/** Idempotent: safe to run again after anything else rewrites the active set. */
		const pruneTools = (): string[] => {
			if (kit.role.isChild) return [];
			const drop = new Set((Array.isArray(cfg.dropTools) ? cfg.dropTools : []).filter((n): n is string => typeof n === "string" && n !== ""));
			if (drop.size === 0) return [];
			// Reported against the registry, not the active set: on /reload pi carries
			// the active set over, so the names are already gone when this runs again.
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const held = [...drop].filter((name) => registered.has(name));
			const active = pi.getActiveTools();
			const next = active.filter((name) => !drop.has(name));
			if (next.length !== active.length) pi.setActiveTools(next);
			return held;
		};

		pi.on("session_start", (_event, ctx) => {
			decision = undefined;
			removedChars = 0;
			try {
				shouldCollapse(ctx.cwd);
			} catch (error) {
				kit.log("prune", `project check failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				dropped = pruneTools();
			} catch (error) {
				dropped = [];
				kit.log("prune", `tool prune failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});

		pi.on("before_agent_start", (event, ctx) => {
			try {
				if (!shouldCollapse(ctx.cwd)) return undefined;
				const pruned = collapseDocsSection(event.systemPrompt);
				if (pruned === event.systemPrompt) return undefined;
				// Measured on the strings themselves, so a pi upgrade that rewords the
				// section re-measures instead of trusting a constant. Counted once per
				// session: the prompt is the cached prefix, cut once and re-read after.
				if (removedChars === 0) kit.ledger.add("prune", event.systemPrompt.length, pruned.length);
				removedChars = event.systemPrompt.length - pruned.length;
				return { systemPrompt: pruned };
			} catch (error) {
				kit.log("prune", `collapse failed: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		});

		pi.registerCommand("prune", {
			description: "What prune holds out of every request",
			handler: async (_args, ctx) => {
				const lines: string[] = [];
				let collapse = false;
				try {
					collapse = shouldCollapse(ctx.cwd);
				} catch {}
				if (cfg.docs === false) {
					lines.push("docs: collapse off (settings.json → prune.docs)");
				} else if (!collapse) {
					lines.push("docs: full section kept — this looks like a pi project (PI_TOOLKIT_PRUNE_DOCS=always overrides)");
				} else if (removedChars === 0) {
					lines.push("docs: armed — nothing measured yet (the first prompt build of the session is what gets cut)");
				} else {
					lines.push(`docs: section collapsed, ~${Math.ceil(removedChars / 4)} tokens held out of every request`);
				}
				lines.push(dropped.length > 0 ? `tools: holding back ${dropped.join(", ")} — never called here, and bash answers both` : "tools: none held back (settings.json → prune.dropTools)");
				kit.print("prune", [], lines);
			},
		});
	},
};

export default module;
