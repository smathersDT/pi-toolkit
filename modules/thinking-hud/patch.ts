/**
 * Blank-line fix for the emptied hidden-thinking label.
 *
 * pi's AssistantMessageComponent renders the hidden-thinking label
 * unconditionally and treats a non-empty thinking block as visible content
 * (a leading spacer). With the label set to "" that is two blank lines per
 * turn that thought before calling tools, stacking into a wall of whitespace.
 *
 * The patch filters thinking blocks out of the message before the original
 * render sees them, only while hideThinkingBlock is on and the label is "",
 * so the stock "Thinking..." placeholder is untouched. It is defensive: if a
 * pi upgrade renames the fields, nothing is patched.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi-toolkit.thinking-hud.blank-lines");

type Patchable = {
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	lastMessage?: unknown;
	updateContent?: (message: unknown, isStreaming?: boolean) => void;
} & Record<symbol, unknown>;

export function patchHiddenThinkingBlankLines(): boolean {
	try {
		const proto = AssistantMessageComponent?.prototype as unknown as Patchable | undefined;
		if (!proto || proto[PATCHED]) return !!proto?.[PATCHED];
		const original = proto.updateContent;
		if (typeof original !== "function" || !("hiddenThinkingLabel" in proto || true)) return false;
		proto[PATCHED] = true;
		proto.updateContent = function (this: Patchable, message: unknown, isStreaming?: boolean) {
			const m = message as { content?: Array<{ type: string }> } | undefined;
			let toRender = message;
			if (m?.content && this.hideThinkingBlock && this.hiddenThinkingLabel === "" && m.content.some((b) => b.type === "thinking")) {
				toRender = { ...m, content: m.content.filter((b) => b.type !== "thinking") };
			}
			original.call(this, toRender, isStreaming);
			this.lastMessage = message;
		};
		return true;
	} catch {
		return false;
	}
}
