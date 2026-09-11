/**
 * tool-fixes — execute-level fixes for mistakes models keep making with the
 * built-in tools, so they never become failures, nudges or lessons:
 *
 *   grep   a pattern ripgrep cannot parse (`ApiResponse(200`, `,true)]`) is
 *          searched again as a literal string; one line in front of the
 *          result says so. Seen 3 times in 2 repos on 2026-09-11.
 *   bash   on Windows the description says the shell is Git Bash, not
 *          PowerShell (a model chained `if ($LASTEXITCODE …)` into bash).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AnyToolDefinition, Toolkit, ToolkitModule } from "../../core/kit.ts";

const REGEX_ERROR = /regex parse error/i;

export const BASH_WINDOWS_NOTE =
	"On Windows this is Git Bash: POSIX syntax, not PowerShell. Run PowerShell as pwsh -NoProfile -File script.ps1 or pwsh -NoProfile -Command '…', and chain with && rather than $LASTEXITCODE checks.";

/** The first line of a ripgrep regex error worth quoting: "unclosed group". */
export function regexProblem(message: string): string {
	return /(?:^|\n)\s*error:[ \t]*([^\n]+)/.exec(message)?.[1]?.trim() || "invalid regex";
}

type Content = Array<{ type: string; text?: string }>;

export function patchGrep(def: AnyToolDefinition): AnyToolDefinition {
	return {
		...def,
		async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
			try {
				return await def.execute(toolCallId, params, signal, onUpdate, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (params?.literal === true || !REGEX_ERROR.test(message)) throw error;
				const result = await def.execute(toolCallId, { ...params, literal: true }, signal, onUpdate, ctx);
				const note = `[grep: not a valid regex (${regexProblem(message)}); searched as a literal string]`;
				const content = (result?.content ?? []) as Content;
				return { ...result, content: [{ type: "text", text: note }, ...content] };
			}
		},
	};
}

export function patchBash(def: AnyToolDefinition): AnyToolDefinition {
	return { ...def, description: `${def.description ?? ""} ${BASH_WINDOWS_NOTE}`.trim() };
}

const module: ToolkitModule = {
	id: "tool-fixes",
	label: "Tool fixes",
	description: "grep retries a pattern that is not a valid regex as a literal; on Windows bash says it is not PowerShell",
	default: true,
	order: 35,
	child: "always",
	setup(_pi: ExtensionAPI, kit: Toolkit) {
		kit.patchTool("grep", patchGrep);
		if (process.platform === "win32") kit.patchTool("bash", patchBash);
	},
};

export default module;
