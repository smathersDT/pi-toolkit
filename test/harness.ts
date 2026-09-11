/**
 * A fake pi host for unit tests: records every registration, lets a test fire
 * events at the handlers, and provides a theme whose colour functions are
 * identity (so rendered strings can be compared byte for byte).
 *
 * Nothing here needs the real pi runtime, so `node --test` works.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAgentDir } from "../core/paths.ts";

export interface FakeTool {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderShell?: string;
	execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: ((r: any) => void) | undefined, ctx: any) => Promise<any>;
	renderCall?: (args: any, theme: any, context: any) => any;
	renderResult?: (result: any, options: any, theme: any, context: any) => any;
}

export interface FakeCommand {
	description?: string;
	handler: (args: string, ctx: any) => Promise<void> | void;
	getArgumentCompletions?: (prefix: string) => unknown;
}

export interface FakeMessage {
	message: unknown;
	options?: unknown;
}

/** Identity theme: fg/bg/bold return their text unchanged. */
export const plainTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
};

export class FakePi {
	handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	tools = new Map<string, FakeTool>();
	commands = new Map<string, FakeCommand>();
	shortcuts = new Map<string, { description?: string; handler: (ctx: any) => any }>();
	entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	messageRenderers = new Map<string, (message: any, options: any, theme: any) => any>();
	entries: Array<{ customType: string; data: unknown }> = [];
	sent: FakeMessage[] = [];
	userMessages: Array<{ content: unknown; options?: unknown }> = [];
	activeTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	events = new EventEmitter();
	thinkingLevel = "medium";
	model: any = undefined;
	execResults = new Map<string, { stdout: string; stderr: string; code: number }>();

	on(event: string, handler: (event: any, ctx: any) => any): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerTool(tool: FakeTool): void {
		this.tools.set(tool.name, tool);
		if (!this.activeTools.includes(tool.name)) this.activeTools.push(tool.name);
	}

	registerCommand(name: string, command: FakeCommand): void {
		this.commands.set(name, command);
	}

	registerShortcut(key: string, options: { description?: string; handler: (ctx: any) => any }): void {
		this.shortcuts.set(key, options);
	}

	registerFlag(): void {}
	getFlag(): undefined {
		return undefined;
	}

	registerEntryRenderer(customType: string, renderer: (entry: any, options: any, theme: any) => any): void {
		this.entryRenderers.set(customType, renderer);
	}

	registerMessageRenderer(customType: string, renderer: (message: any, options: any, theme: any) => any): void {
		this.messageRenderers.set(customType, renderer);
	}

	registerMarkdownTransformer(): void {}

	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.sent.push({ message, options });
	}

	sendUserMessage(content: unknown, options?: unknown): void {
		this.userMessages.push({ content, options });
	}

	getActiveTools(): string[] {
		return [...this.activeTools];
	}

	getAllTools(): Array<{ name: string; description: string; sourceInfo: { source: string } }> {
		return this.activeTools.map((name) => ({ name, description: name, sourceInfo: { source: "builtin" } }));
	}

	setActiveTools(names: string[]): void {
		this.activeTools = [...names];
	}

	getThinkingLevel(): string {
		return this.thinkingLevel;
	}

	setThinkingLevel(level: string): void {
		this.thinkingLevel = level;
	}

	async setModel(model: any): Promise<boolean> {
		this.model = model;
		return true;
	}

	getSessionName(): undefined {
		return undefined;
	}

	setSessionName(): void {}
	setLabel(): void {}

	async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
		const key = [command, ...args].join(" ");
		const r = this.execResults.get(key) ?? { stdout: "", stderr: "", code: 0 };
		return { ...r, killed: false };
	}

	getCommands(): unknown[] {
		return [...this.commands.keys()].map((name) => ({ name, source: "extension" }));
	}

	/** Fire an event through every handler in registration order; returns the results. */
	async emit(event: string, payload: any, ctx: any = makeCtx()): Promise<any[]> {
		const results: any[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	}

	/** tool_result-style chaining: each handler sees the previous patch applied. */
	async chainToolResult(payload: any, ctx: any = makeCtx()): Promise<any> {
		let current = { ...payload };
		for (const handler of this.handlers.get("tool_result") ?? []) {
			const patch = await handler(current, ctx);
			if (patch && typeof patch === "object") current = { ...current, ...patch };
		}
		return current;
	}
}

export interface FakeCtxOptions {
	cwd?: string;
	mode?: string;
	model?: any;
	entries?: unknown[];
	sessionFile?: string;
	confirm?: (title: string, message: string) => Promise<boolean>;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}

export function makeCtx(options: FakeCtxOptions = {}): any {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let workingMessage: string | undefined;
	let hiddenThinkingLabel: string | undefined;
	let workingIndicator: unknown;
	const ctx: any = {
		cwd: options.cwd ?? process.cwd(),
		mode: options.mode ?? "tui",
		hasUI: (options.mode ?? "tui") !== "print",
		model: options.model ?? { provider: "test", id: "test-model", reasoning: true, cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } },
		thinkingLevel: "medium",
		signal: undefined,
		modelRegistry: {
			getAvailable: () => [ctx.model],
			getAll: () => [ctx.model],
			find: (provider: string, id: string) => (ctx.model.provider === provider && ctx.model.id === id ? ctx.model : undefined),
		},
		sessionManager: {
			getEntries: () => options.entries ?? [],
			getBranch: () => options.entries ?? [],
			buildContextEntries: () => options.entries ?? [],
			getSessionFile: () => options.sessionFile,
			getSessionId: () => "session-test",
			getSessionDir: () => undefined,
		},
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => {},
		reload: async () => {},
		newSession: async () => ({ cancelled: false }),
		ui: {
			theme: plainTheme,
			notifications,
			statuses,
			widgets,
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			confirm: options.confirm ?? (async () => true),
			select: options.select ?? (async (_t: string, opts: string[]) => opts[0]),
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWidget: (key: string, content: unknown) => widgets.set(key, content),
			setWorkingMessage: (m?: string) => {
				workingMessage = m;
			},
			getWorkingMessage: () => workingMessage,
			setWorkingVisible: () => {},
			setWorkingIndicator: (o?: unknown) => {
				workingIndicator = o;
			},
			getWorkingIndicator: () => workingIndicator,
			setHiddenThinkingLabel: (l?: string) => {
				hiddenThinkingLabel = l;
			},
			getHiddenThinkingLabel: () => hiddenThinkingLabel,
			setTitle: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			pasteToEditor: () => {},
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			setFooter: () => {},
		},
	};
	return ctx;
}

/** A fresh temp agent dir so tests never touch the real settings. */
export function tempAgentDir(prefix = "pi-toolkit-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	setAgentDir(dir);
	return dir;
}

/** Minimal render context for renderCall/renderResult. */
export function renderContext(args: unknown, overrides: Partial<Record<string, unknown>> = {}): any {
	return {
		args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

/** Render a Component to plain lines at a width. */
export function renderLines(component: { render(width: number): string[] }, width = 80): string[] {
	return component.render(width);
}
