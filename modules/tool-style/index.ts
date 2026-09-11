/**
 * tool-style — every built-in tool (bash, read, edit, write, grep, find, ls)
 * rendered inside the toolkit's boxed frame:
 *
 *   /--BASH-------------------------------
 *   | git status --porcelain
 *   |
 *   | M src/index.ts
 *   | ?? notes.md
 *   | … +14 lines (ctrl+o to expand)
 *   \--------------------------------------
 *
 * Once the call finishes, a collapsed row shrinks to one summary line; expanding
 * (ctrl+o, or a click) shows the whole frame again:
 *
 *   ✓ BASH git status --porcelain · 16 lines · ?? notes.md
 *
 * Display only. The tool definitions keep pi's execute, schema and prompt text;
 * only `renderCall` (a FrameTop) and `renderResult` (a FrameBottom) change, and
 * `renderShell: "self"` opts out of pi's background box. Nothing reaches the model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FrameBottom, type FrameRowState, type FrameState, FrameTop, type FrameTheme, summaryLine } from "../../core/frame.ts";
import { BUILTIN_TOOL_NAMES, type BuiltinToolName, type Toolkit, type ToolkitModule } from "../../core/kit.ts";
import { headLines, summaryHead, summaryStats, type ToolResultLike, toolBody } from "./render.ts";

/** Row state shared between the call and result slots of one tool row. */
interface RowState extends FrameRowState {
	/** The header as it was last rendered, so the result slot knows whether it must recolour. */
	headerState?: FrameState;
	/** The FrameTop instance, so the result slot can flip its state before the next paint. */
	top?: FrameTop;
	/** The finished row's one-line summary. */
	summary?: string;
}

/** The parts of pi's ToolRenderContext these renderers read. */
interface RenderCtx {
	args: unknown;
	state: RowState;
	cwd: string;
	executionStarted: boolean;
	isError: boolean;
	expanded?: boolean;
	invalidate: () => void;
	lastComponent: unknown;
}

interface ResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

/** The renderCall / renderResult pair for one built-in tool. */
export function toolRenderers(name: BuiltinToolName) {
	const title = name.toUpperCase();
	return {
		renderCall(args: unknown, theme: FrameTheme, context: RenderCtx): FrameTop {
			const st = context.state;
			const state: FrameState = context.isError || st.error ? "error" : st.done ? "ok" : "running";
			// The blank gutter line only makes sense when a body follows it.
			const separator = !!st.done || context.executionStarted;
			const head = headLines(name, args, context.cwd);
			const last = context.lastComponent;
			const top = last instanceof FrameTop ? last.update(title, head, state, separator) : new FrameTop(title, head, state, theme, separator);
			top.summary = st.done && !context.expanded ? st.summary : undefined;
			st.headerState = state;
			st.top = top;
			return top;
		},
		renderResult(result: ToolResultLike, options: ResultOptions, theme: FrameTheme, context: RenderCtx): FrameBottom {
			const st = context.state;
			const collapsed = !options.isPartial && !options.expanded;
			if (!options.isPartial) {
				st.done = true;
				st.error = !!context.isError;
				const state: FrameState = st.error ? "error" : "ok";
				const stats = summaryStats(name, { result, args: context.args, isError: !!context.isError });
				st.summary = summaryLine(title, summaryHead(name, context.args, context.cwd), stats, state, theme);
				// pi renders the header before the result in the same pass, so flip the
				// instance it already produced: the very next paint shows the closing state.
				if (st.top) {
					st.top.state = state;
					st.top.separator = true;
					st.top.summary = collapsed ? st.summary : undefined;
				}
				if (st.headerState === "running" && !st.invalidated) {
					st.invalidated = true;
					// Deferred: a synchronous invalidate re-enters pi's row update from inside
					// this renderer and the result slot would be added twice.
					queueMicrotask(() => {
						try {
							context.invalidate();
						} catch {}
					});
				}
			}
			const { body, footer } = toolBody(
				name,
				{ result, args: context.args, expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
				theme,
			);
			const last = context.lastComponent;
			const bottom = last instanceof FrameBottom ? last.update(body, footer) : new FrameBottom(body, theme, footer);
			bottom.hidden = collapsed;
			return bottom;
		},
	};
}

const module: ToolkitModule = {
	id: "tool-style",
	label: "Tool frames",
	description: "Built-in tools render inside the boxed frame",
	default: true,
	order: 70,
	child: "never",
	setup(_pi: ExtensionAPI, kit: Toolkit) {
		for (const name of BUILTIN_TOOL_NAMES) {
			const { renderCall, renderResult } = toolRenderers(name);
			kit.patchTool(name, (def) => ({ ...def, renderShell: "self", renderCall, renderResult }));
		}
	},
};

export default module;
