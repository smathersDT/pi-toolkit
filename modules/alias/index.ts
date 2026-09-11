/**
 * alias — the command names muscle memory reaches for.
 *
 * pi starts a fresh session with `/new` and leaves with `/quit`; other agent
 * CLIs spell those `/clear` and `/exit`. Built-in commands cannot be overridden
 * by an extension, so this is additive: the aliases join the completion list
 * beside the originals.
 *
 * Config: `{ aliases: { clear: "new", exit: "quit", q: "quit" } }`. Two targets
 * exist, `new` and `quit`; an alias naming anything else is ignored.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";

const DEFAULTS = { aliases: { clear: "new", exit: "quit", q: "quit" } as Record<string, string> };

const module: ToolkitModule = {
	id: "alias",
	label: "Command aliases",
	description: "/clear, /exit and /q as aliases for /new and /quit",
	default: true,
	order: 90,
	child: "never",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const cfg = kit.config("alias", DEFAULTS);
		for (const [name, target] of Object.entries(cfg.aliases ?? {})) {
			if (!/^[a-z][a-z0-9_-]*$/i.test(name)) continue;
			if (target === "new") {
				pi.registerCommand(name, {
					description: "Start a new session (alias for /new)",
					handler: async (_args, ctx) => {
						// The captured ctx is stale once the session is replaced, so the notice
						// goes through the fresh ctx that withSession hands over.
						await ctx.newSession({
							withSession: async (fresh) => {
								try {
									fresh.ui.notify("New session started");
								} catch {}
							},
						});
					},
				});
			} else if (target === "quit") {
				pi.registerCommand(name, {
					description: "Quit pi (alias for /quit)",
					handler: async (_args, ctx) => {
						ctx.shutdown();
					},
				});
			} else {
				kit.log("alias", `ignoring /${name}: unknown target "${target}" (expected "new" or "quit")`);
			}
		}
	},
};

export default module;
