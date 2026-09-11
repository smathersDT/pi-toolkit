/**
 * clear-on-exit — wipe the terminal when pi exits.
 *
 * Written from `process.on("exit")` rather than `session_shutdown` so it lands
 * after pi's own teardown has finished painting. The sequence is ANSI, not a
 * shelled-out `clear`/`cls`: 2J wipes the screen, 3J the scrollback, H homes
 * the cursor, and the same three codes work on Windows Terminal, conhost with
 * VT, macOS Terminal, iTerm and every Linux emulator.
 *
 * Only a real interactive TUI on a real terminal: piping pi's output to a file
 * or running it headless must not get escape codes in the payload.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolkitModule } from "../../core/kit.ts";

/**
 * One exit handler per process. `/reload` re-evaluates this module, so the
 * flag lives on globalThis under a well-known symbol rather than in module
 * scope alone.
 */
const FLAG = Symbol.for("pi-toolkit.clear-on-exit.registered");
let registered = false;

function alreadyRegistered(): boolean {
	return registered || (globalThis as Record<symbol, unknown>)[FLAG] === true;
}

function markRegistered(): void {
	registered = true;
	(globalThis as Record<symbol, unknown>)[FLAG] = true;
}

const module: ToolkitModule = {
	id: "clear-on-exit",
	label: "Clear terminal on exit",
	description: "Wipe the screen and scrollback when pi quits from a real terminal",
	default: true,
	order: 91,
	child: "never",
	setup(pi: ExtensionAPI) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || !process.stdout.isTTY || alreadyRegistered()) return;
			markRegistered();
			process.on("exit", () => {
				try {
					process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
				} catch {}
			});
		});
	},
};

export default module;
