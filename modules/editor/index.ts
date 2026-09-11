/**
 * editor — prompt history that outlives the process.
 *
 * pi's editor history lives only in memory, so closing pi loses everything you
 * typed. This preloads the editor from `<agent-dir>/toolkit/history.json` at
 * startup (up-arrow works immediately, in any project) and writes every
 * submitted prompt back, newest first, capped at 200, slash commands excluded.
 *
 * pi calls the editor's `addToHistory` after each successful submission, so
 * overriding it is the submission hook; the list it reads for up/down lives in
 * the upstream Editor's TS-private `history` field, which is patched in place.
 * If a pi upgrade removes that field, the module degrades to stock in-memory
 * history and says so once at session start.
 *
 * Another extension may already own the editor: its factory is kept and the
 * instance it builds gets the same history treatment, duck-typed.
 */
import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { historyFile, isSlashCommand, loadHistory, MAX_ENTRIES, persistEntry } from "./history.ts";

/** The slice of the upstream Editor this module leans on. */
interface HistoryHost {
	history?: unknown;
	addToHistory?: (text: string) => void;
}

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor;

/** Marks our own factory so a reload composes with it instead of wrapping it twice. */
const MARK = Symbol.for("pi-toolkit.editor.factory");

/** Replace the editor's in-memory list with the on-disk one; false when the field is gone. */
function preload(editor: object, file: string): boolean {
	const host = editor as HistoryHost;
	if (!Array.isArray(host.history)) return false;
	host.history = loadHistory(file);
	return true;
}

/** Record a submitted prompt in memory and on disk; false when there is no list to record into. */
function record(editor: object, file: string, text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || isSlashCommand(trimmed)) return true;
	const history = (editor as HistoryHost).history;
	if (!Array.isArray(history)) return false;
	if (history[0] !== trimmed) {
		history.unshift(trimmed);
		if (history.length > MAX_ENTRIES) history.length = MAX_ENTRIES;
	}
	persistEntry(file, trimmed);
	return true;
}

export class HistoryEditor extends CustomEditor {
	historyPath: string;
	/** False when the upstream `history` field is missing and stock behaviour is in force. */
	historySupported: boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, file: string) {
		super(tui, theme, keybindings);
		this.historyPath = file;
		this.historySupported = preload(this, file);
	}

	override addToHistory(text: string): void {
		if (!record(this, this.historyPath, text)) super.addToHistory(text);
	}
}

/** Give an editor built by another extension's factory the same history. */
export function attachHistory(editor: object, file: string): boolean {
	const supported = preload(editor, file);
	const host = editor as HistoryHost;
	const original = typeof host.addToHistory === "function" ? host.addToHistory.bind(editor) : undefined;
	host.addToHistory = (text: string) => {
		if (!record(editor, file, text)) original?.(text);
	};
	return supported;
}

const module: ToolkitModule = {
	id: "editor",
	label: "Persistent prompt history",
	description: "Up-arrow history preloaded from disk and written back after every prompt",
	default: true,
	order: 93,
	child: "never",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const file = historyFile(kit.paths.agentDir);
		let installed = false;

		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || installed) return;
			try {
				const previous = ctx.ui.getEditorComponent() as (EditorFactory & { [MARK]?: boolean }) | undefined;
				// pi keeps the factory across reloads; ours from before is already wired.
				if (previous && previous[MARK]) {
					installed = true;
					return;
				}
				let unsupported = false;
				const factory: EditorFactory & { [MARK]?: boolean } = (tui, theme, keybindings) => {
					if (previous) {
						const editor = previous(tui, theme, keybindings);
						if (!attachHistory(editor, file)) unsupported = true;
						return editor;
					}
					const editor = new HistoryEditor(tui, theme, keybindings, file);
					if (!editor.historySupported) unsupported = true;
					return editor;
				};
				factory[MARK] = true;
				ctx.ui.setEditorComponent(factory as never);
				installed = true;
				if (unsupported) {
					ctx.ui.notify("editor: pi's Editor no longer exposes its history list — prompts are not saved or preloaded (toolkit editor module needs an update)", "warning");
				}
			} catch (error) {
				kit.log("editor", `install failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	},
};

export default module;
