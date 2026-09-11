/**
 * pi-toolkit — one extension, many modules, each switchable from `/toolkit`.
 *
 * Every module is a small self-contained unit under `modules/<id>/index.ts`
 * exporting a `ToolkitModule`. This entry point loads the enabled ones in
 * `order`, hands them the shared `Toolkit` context, registers the patched
 * built-in tools once, and adds the `/toolkit` menu.
 *
 * In a subagent child (spawned by the subagent module) only the modules whose
 * `child` policy allows it are loaded, and the menu is skipped.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolkit, moduleEnabled, moduleLoadsHere, type ToolkitModule } from "./core/kit.ts";
import { registerMenu } from "./core/menu.ts";
import { MODULES } from "./modules/index.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	const kit = createToolkit(pi);
	const modules = [...MODULES].sort((a, b) => a.order - b.order);
	for (const module of modules) {
		if (!moduleEnabled(module, kit.settings) || !moduleLoadsHere(module, kit.role)) continue;
		try {
			await module.setup(pi, kit);
			kit.enabled.add(module.id);
			kit.log("core", `loaded ${module.id}`);
		} catch (error) {
			process.stderr.write(`[toolkit] module ${module.id} failed to load: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		}
	}
	kit.flushToolPatches(pi);
	if (!kit.role.isChild) registerMenu(pi, kit, modules);
}

export { MODULES } from "./modules/index.ts";
export type { Toolkit, ToolkitModule } from "./core/kit.ts";
