/**
 * sticky-model — a new session opens on the model and thinking level the last
 * one ended with.
 *
 * pi reads `defaultProvider`, `defaultModel`, `defaultThinkingLevel` and
 * `modelThinkingLevels` from settings.json at startup but never writes them on
 * a switch. This makes every `/model`, ctrl+p and thinking change the default.
 *
 * Thinking is remembered per model in `modelThinkingLevels`. The global
 * `defaultThinkingLevel` is only rewritten by a deliberate change on the model
 * already in use, never by the clamp a model switch performs on its way in.
 *
 * Nothing here reaches the model: two event handlers and a JSON merge.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { type Changes, remember } from "./settings.ts";

interface ModelLike {
	provider?: string;
	id?: string;
	reasoning?: boolean;
}

/** How `modelThinkingLevels` is keyed, and how a model change is detected. */
function keyOf(model: ModelLike | undefined): string | undefined {
	return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}

const module: ToolkitModule = {
	id: "sticky-model",
	label: "Remember model & thinking",
	description: "Every model or thinking switch becomes the default for the next session",
	default: true,
	order: 85,
	child: "never",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const file = join(kit.paths.agentDir, "settings.json");
		/** The model the last event was about — undefined until a session reports one. */
		let currentKey: string | undefined;

		const save = (changes: Changes): void => {
			try {
				remember(file, changes);
			} catch (error) {
				kit.log("sticky-model", `settings write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		};

		pi.on("session_start", (_event, ctx) => {
			currentKey = keyOf(ctx.model as ModelLike | undefined);
		});

		pi.on("model_select", (event) => {
			const model = event.model as ModelLike | undefined;
			const key = keyOf(model);
			// A restored session is replaying a choice already made, not making one.
			if (key && event.source !== "restore") {
				save({ defaultProvider: model?.provider, defaultModel: model?.id });
			}
			if (key) currentKey = key;
		});

		pi.on("thinking_level_select", (event, ctx) => {
			const level = event.level as string | undefined;
			if (!level) return;
			const model = ctx.model as ModelLike | undefined;
			const key = keyOf(model);
			const changes: Changes = {};
			if (key) changes.thinkingFor = { key, level };
			// This event fires ahead of `model_select` on a switch, with ctx.model already
			// the incoming one — so a key that moved means the level was resolved for a new
			// model, not picked for this one, and the global fallback stays as it was.
			const switching = currentKey !== undefined && key !== currentKey;
			if (!switching && model?.reasoning) changes.defaultThinkingLevel = level;
			save(changes);
		});
	},
};

export default module;
