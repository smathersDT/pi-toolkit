/**
 * The module list. Order here is cosmetic (the menu); load order is `order`.
 * Add a module by importing it and appending to the array.
 */
import type { ToolkitModule } from "../core/kit.ts";
import alias from "./alias/index.ts";
import autoLearn from "./auto-learn/index.ts";
import clearOnExit from "./clear-on-exit/index.ts";
import compact from "./compact/index.ts";
import editor from "./editor/index.ts";
import footer from "./footer/index.ts";
import images from "./images/index.ts";
import keepalive from "./keepalive/index.ts";
import modelSync from "./model-sync/index.ts";
import permissions from "./permissions/index.ts";
import preSend from "./pre-send/index.ts";
import prune from "./prune/index.ts";
import session from "./session/index.ts";
import stickyModel from "./sticky-model/index.ts";
import subagent from "./subagent/index.ts";
import thinkingHud from "./thinking-hud/index.ts";
import toolFixes from "./tool-fixes/index.ts";
import toolStyle from "./tool-style/index.ts";
import web from "./web/index.ts";

export const MODULES: ToolkitModule[] = [
	permissions,
	prune,
	compact,
	images,
	autoLearn,
	toolFixes,
	keepalive,
	subagent,
	web,
	session,
	toolStyle,
	thinkingHud,
	footer,
	modelSync,
	stickyModel,
	alias,
	clearOnExit,
	preSend,
	editor,
];
