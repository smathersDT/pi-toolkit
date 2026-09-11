/**
 * The shared context every module receives: settings, paths, the role of this
 * process, the savings ledger, the frame renderer, and the built-in tool patch
 * pipeline that lets several modules wrap the same built-in tool without
 * registering it twice.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { FrameState } from "./frame.ts";
import { Ledger } from "./ledger.ts";
import { agentDir, extensionRoot, toolkitDir } from "./paths.ts";
import { printFrame, registerFramePrinter } from "./print.ts";
import { detectRole, type RuntimeRole } from "./role.ts";
import { loadSettings, mergeConfig, saveSettings, type ToolkitSettings } from "./settings.ts";

export type AnyToolDefinition = ToolDefinition<any, any, any>;
export type ToolPatch = (def: AnyToolDefinition) => AnyToolDefinition;

/** pi's built-in tools the toolkit can re-register with patches. */
export const BUILTIN_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** Which modules a child process (spawned by the subagent module) loads. */
export type ChildPolicy = "always" | "never" | string[];

export interface ToolkitModule {
	/** Settings key and menu id, e.g. "tool-style". */
	id: string;
	label: string;
	description: string;
	/** Enabled when the settings file has no entry. */
	default: boolean;
	/** Load order; lower runs first. Hooks fire in registration order. */
	order: number;
	/** Whether to load in subagent children: always, never, or only for the listed roles. */
	child: ChildPolicy;
	setup(pi: ExtensionAPI, kit: Toolkit): void | Promise<void>;
}

export interface Toolkit {
	settings: ToolkitSettings;
	role: RuntimeRole;
	ledger: Ledger;
	paths: { agentDir: string; toolkitDir: string; root: string };
	/** Module ids that are loaded in this process. */
	enabled: Set<string>;
	/** A module's config section merged over its defaults. */
	config<T extends object>(moduleId: string, defaults: T): T;
	/** Persist a module's config section. */
	saveConfig(moduleId: string, value: unknown): void;
	/** Wrap a built-in tool definition. Patches compose in module order. */
	patchTool(name: BuiltinToolName, patch: ToolPatch): void;
	/** Register the patched built-ins. Called once by the entry point after setup. */
	flushToolPatches(pi: ExtensionAPI): void;
	/** Debug log to stderr when PI_TOOLKIT_DEBUG is set. */
	log(module: string, message: string): void;
	/** Print a framed, display-only report into the transcript. */
	print(title: string, head: string[], lines: string[], state?: FrameState, collapsed?: boolean): void;
}

const builtinFactories: Record<BuiltinToolName, (cwd: string) => AnyToolDefinition> = {
	bash: (cwd) => createBashToolDefinition(cwd) as AnyToolDefinition,
	read: (cwd) => createReadToolDefinition(cwd) as AnyToolDefinition,
	edit: (cwd) => createEditToolDefinition(cwd) as AnyToolDefinition,
	write: (cwd) => createWriteToolDefinition(cwd) as AnyToolDefinition,
	grep: (cwd) => createGrepToolDefinition(cwd) as AnyToolDefinition,
	find: (cwd) => createFindToolDefinition(cwd) as AnyToolDefinition,
	ls: (cwd) => createLsToolDefinition(cwd) as AnyToolDefinition,
};

export function createToolkit(pi: ExtensionAPI, settings: ToolkitSettings = loadSettings()): Toolkit {
	const patches = new Map<BuiltinToolName, ToolPatch[]>();
	const debug = !!process.env.PI_TOOLKIT_DEBUG;
	registerFramePrinter(pi);
	const kit: Toolkit = {
		settings,
		role: detectRole(),
		ledger: new Ledger(),
		paths: { agentDir: agentDir(), toolkitDir: toolkitDir(), root: extensionRoot() },
		enabled: new Set(),
		config<T extends object>(moduleId: string, defaults: T): T {
			return mergeConfig(defaults, settings[moduleId]);
		},
		saveConfig(moduleId, value) {
			settings[moduleId] = value;
			saveSettings(settings);
		},
		patchTool(name, patch) {
			const list = patches.get(name) ?? [];
			list.push(patch);
			patches.set(name, list);
		},
		flushToolPatches(pi) {
			for (const [name, list] of patches) {
				let def = builtinFactories[name](process.cwd());
				for (const patch of list) def = patch(def);
				pi.registerTool(def as ToolDefinition);
			}
			patches.clear();
		},
		log(module, message) {
			if (debug) process.stderr.write(`[toolkit:${module}] ${message}\n`);
		},
		print(title, head, lines, state = "ok", collapsed = false) {
			printFrame(pi, title, head, lines, state, collapsed);
		},
	};
	return kit;
}

export function moduleLoadsHere(module: ToolkitModule, role: RuntimeRole): boolean {
	if (!role.isChild) return true;
	if (module.child === "always") return true;
	if (module.child === "never") return false;
	return role.role !== undefined && module.child.includes(role.role);
}

export function moduleEnabled(module: ToolkitModule, settings: ToolkitSettings): boolean {
	const value = settings.modules[module.id];
	return typeof value === "boolean" ? value : module.default;
}
