/**
 * footer — pi's three-line footer replaced by two lines that can be read at a glance.
 *
 *   $0.042  deepseek-v4-pro · high (shift+tab) · $0.28/$0.42/$0.028  ctx 31k/1M 3%      balance $11.09
 *   bg 1 job 2m  agents 2 running
 *
 * Line one: session cost (green; the sum of `usage.cost.total` over the session
 * entries, subagent spend included, cached by entry count), the model id (accent), the thinking level in pi's
 * colour for it with the live `app.thinking.cycle` key, the per-1M rates in/out/cached
 * (dim; hidden when all zero), the context chip `ctx used/window pct%` (text under
 * 60%, warning under 85%, error above), and the account chip flush right when it fits
 * (Copilot quota, DeepSeek balance, Codex windows, OpenAI spend — see account.ts).
 *
 * Line two, each chip hidden when idle, in this order:
 *   bg N jobs <age>     running jobs in the keepalive registry (only with keepalive on)
 *   agents N running    from a `subagent` extension status, when some extension sets
 *                       one; the toolkit's subagent module publishes none yet, so this
 *                       chip is absent until it does (nothing was added there)
 *   key value           every other extension status, `key:` prefix stripped, wrapped
 *                       (auto-learn's `learn` status is hidden)
 *
 * Deliberately not shown: the git branch, token counts, cache stats, cwd, session name.
 * Everything is display-only; the account probes fetch only while a TUI footer is on
 * screen, so headless runs make no requests. `/footer on|off|account`.
 */
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { state as keepalive } from "../keepalive/api.ts";
import { SPEND_ENTRY } from "../subagent/usage.ts";
import { LOGIN_EXPIRED, PROBES } from "./account.ts";
import { AccountPoller, type PollerDeps } from "./poller.ts";
import { agentsChip, bgChip, type Chip, contextChip, layoutFooter, paintChip, sessionLine, statusChips, type ThemeLike } from "./view.ts";

export interface FooterConfig {
	/** The account chip (and its network probes). */
	account: boolean;
	/** The per-1M rates after the model. */
	rates: boolean;
	/** The `ctx used/window pct%` chip. */
	context: boolean;
}

const DEFAULTS: FooterConfig = { account: true, rates: true, context: true };

/** How often a footer with running jobs redraws so the `bg` age keeps moving. */
const BG_TICK_MS = 5_000;

/** The key that cycles the thinking level, as bound right now (keybindings.json included). */
function thinkingKey(): string | undefined {
	try {
		return getKeybindings().getKeys("app.thinking.cycle" as any)[0];
	} catch {
		return undefined;
	}
}

/**
 * Sum of `usage.cost.total` over the session, the way pi's footer counts it,
 * plus subagent spend entries. A tool result flagged `spendBooked` carries usage
 * those entries already hold, so it is skipped.
 */
export function sessionCost(entries: readonly any[]): number {
	let cost = 0;
	for (const entry of entries) {
		if (entry?.type === "message") {
			const m = entry.message;
			if ((m?.role === "assistant" || (m?.role === "toolResult" && !m.details?.spendBooked)) && m.usage) cost += m.usage.cost?.total ?? 0;
		} else if (entry?.type === "custom" && entry.customType === SPEND_ENTRY) {
			cost += entry.data?.usage?.cost?.total ?? 0;
		} else if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) {
			cost += entry.usage.cost?.total ?? 0;
		}
	}
	return cost;
}

/**
 * The hostname a model's `baseUrl` points at. `undefined` means no `baseUrl` (the
 * provider's own host); a `baseUrl` that will not parse answers `""`, which no probe
 * guard matches, so a relay's credential is never sent to the provider it was not
 * issued by.
 */
export function hostOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return "";
	}
}

/** One provider's `auth.json` record, or undefined for anything unreadable. */
function credentials(agentDir: string, provider: string): Record<string, unknown> | undefined {
	try {
		const text = readFileSync(join(agentDir, "auth.json"), "utf-8");
		const auth = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
		const record = auth?.[provider];
		return record && typeof record === "object" ? record : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The poller's window onto pi. `current()` reads `ctx.model` through a getter that
 * throws once pi has invalidated the ctx, so every read happens inside the poller's
 * own try/catch. The credential digest makes `/login` (which emits no event) a
 * change of identity, so the chip is refetched at once.
 */
function pollerDeps(kit: Toolkit, current: () => ExtensionContext | undefined): PollerDeps {
	return {
		current: () => {
			const ctx = current();
			if (!ctx) return undefined;
			const provider = ctx.model?.provider;
			const authVersion = provider
				? createHash("sha256")
						.update(
							JSON.stringify([
								credentials(kit.paths.agentDir, provider),
								provider === "github-copilot" ? process.env.COPILOT_GITHUB_TOKEN : undefined,
								provider === "openai" ? process.env.OPENAI_ADMIN_KEY : undefined,
							]),
						)
						.digest("hex")
				: undefined;
			return { provider, baseUrl: ctx.model?.baseUrl, authVersion };
		},
		probes: PROBES,
		// The ctx is captured when the probe starts: `session_shutdown` clears it, and
		// a probe still in flight across a `/new` must not resolve its key to nothing.
		probeDeps: (provider, facts) => {
			const ctx = current();
			const host = hostOf(facts.baseUrl);
			return {
				fetch: globalThis.fetch,
				// Unlike getApiKeyForProvider, this preserves refresh/store errors.
				apiKey: async () => (await ctx?.modelRegistry.getProviderAuth(provider))?.auth.apiKey,
				credentials: () => credentials(kit.paths.agentDir, provider),
				env: (name) => process.env[name] || undefined,
				baseUrl: () => host,
			};
		},
		now: () => Date.now(),
		setInterval: (fn, ms) => {
			const timer = setInterval(fn, ms);
			(timer as { unref?: () => void }).unref?.();
			return { clear: () => clearInterval(timer) };
		},
	};
}

interface ViewDeps {
	theme: ThemeLike;
	data: ReadonlyFooterDataProvider;
	current: () => ExtensionContext | undefined;
	thinking: () => string;
	/** Undefined when the account chip is configured off. */
	account: AccountPoller | undefined;
	/** Line-two chips, in order. */
	chips: () => Chip[];
	hasJobs: () => boolean;
	cfg: FooterConfig;
	requestRender: () => void;
	log: (message: string) => void;
}

/** The component pi asks to render; one per `session_start` / `/footer on`. */
export class FooterView {
	private cachedCost = 0;
	private cachedFor = -1;
	private lastLines: string[] = ["", ""];
	private ticker: ReturnType<typeof setInterval> | undefined;
	private readonly deps: ViewDeps;

	constructor(deps: ViewDeps) {
		this.deps = deps;
		this.ticker = setInterval(() => {
			try {
				if (deps.hasJobs()) deps.requestRender();
			} catch {}
		}, BG_TICK_MS);
		(this.ticker as { unref?: () => void }).unref?.();
	}

	render(width: number): string[] {
		try {
			this.lastLines = this.build(width);
		} catch (error) {
			// A ctx pi has since invalidated; the next event carries a live one.
			this.deps.log(`render: ${String(error)}`);
		}
		return this.lastLines;
	}

	private build(width: number): string[] {
		const { theme, cfg } = this.deps;
		const ctx = this.deps.current();
		let session = "";
		let context: string | undefined;
		if (ctx) {
			const entries = ctx.sessionManager.getEntries();
			if (entries.length !== this.cachedFor) {
				this.cachedCost = sessionCost(entries);
				this.cachedFor = entries.length;
			}
			const model = ctx.model;
			session = sessionLine(
				{
					costUsd: this.cachedCost,
					modelId: model?.id,
					reasoning: model?.reasoning,
					cost: cfg.rates ? model?.cost : undefined,
					thinking: this.deps.thinking(),
					thinkingKey: thinkingKey(),
				},
				theme,
			);
			if (cfg.context) {
				const chip = contextChip(ctx.getContextUsage());
				if (chip) context = paintChip(chip, theme);
			}
		}
		const account = this.deps.account?.get();
		const chips = this.deps.chips().map((c) => paintChip(c, theme));
		return layoutFooter({ session, context, account: account ? paintChip(account, theme) : undefined, chips }, width, visibleWidth, (s, w) =>
			truncateToWidth(s, w, ""),
		);
	}

	invalidate(): void {
		this.cachedFor = -1;
	}

	/** pi replaces the view on every install; the poller goes quiet with it. */
	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		this.deps.account?.dispose();
	}
}

const module: ToolkitModule = {
	id: "footer",
	label: "Two-line footer",
	description: "Cost, model, thinking, rates, context and account on one line; jobs, agents and statuses on the next",
	default: true,
	order: 78,
	child: "never",
	setup(pi: ExtensionAPI, kit: Toolkit) {
		const cfg = kit.config("footer", DEFAULTS);
		let enabled = true;
		let lastCtx: ExtensionContext | undefined;
		const account = new AccountPoller(pollerDeps(kit, () => lastCtx));

		const runningJobs = () => (kit.enabled.has("keepalive") ? keepalive.registry.running() : []);
		const lineTwo = (statuses: ReadonlyMap<string, string>): Chip[] => {
			const chips: Chip[] = [];
			const bg = bgChip(runningJobs(), Date.now());
			if (bg) chips.push(bg);
			const agents = agentsChip(statuses.get("subagent"));
			if (agents) chips.push(agents);
			chips.push(...statusChips(statuses));
			return chips;
		};

		/** Say once, out loud, that the login behind the current model is gone; re-armed when it recovers. */
		let warnedFor: string | undefined;
		const noteLogin = (ctx: ExtensionContext): void => {
			try {
				const provider = ctx.model?.provider;
				if (!provider) return;
				if (account.peek()?.label !== LOGIN_EXPIRED.label) {
					warnedFor = undefined;
					return;
				}
				if (warnedFor === provider) return;
				warnedFor = provider;
				ctx.ui.notify(`footer: ${provider} login expired — run /login to sign in again`, "warning");
			} catch {
				/* a ctx pi has since invalidated */
			}
		};

		const install = (ctx: ExtensionContext): void => {
			// `hasUI` is also true in rpc mode, where `setFooter` is a no-op; only a TUI
			// paints one. The account hangs off `attach`, which only a real footer reaches.
			if (ctx.mode !== "tui") return;
			if (!enabled) account.dispose();
			ctx.ui.setFooter(
				enabled
					? (tui, theme, footerData) => {
							const requestRender = () => tui.requestRender();
							if (cfg.account) account.attach(requestRender);
							return new FooterView({
								theme: theme as unknown as ThemeLike,
								data: footerData,
								current: () => lastCtx,
								thinking: () => pi.getThinkingLevel(),
								account: cfg.account ? account : undefined,
								chips: () => lineTwo(footerData.getExtensionStatuses()),
								hasJobs: () => runningJobs().length > 0,
								cfg,
								requestRender,
								log: (m) => kit.log("footer", m),
							});
						}
					: undefined,
			);
		};

		pi.on("session_start", (_event, ctx) => {
			lastCtx = ctx;
			try {
				install(ctx);
			} catch (error) {
				kit.log("footer", `install: ${String(error)}`);
			}
		});

		// The model and context change between events; keep the freshest ctx to read
		// them from. The turn that just billed moved the account number: ask again
		// under the once-a-minute floor. `isAttached` keeps this off every headless run.
		for (const event of ["before_agent_start", "model_select", "thinking_level_select", "turn_end", "agent_settled"] as const) {
			pi.on(event as any, (_e: unknown, ctx: ExtensionContext) => {
				lastCtx = ctx;
				if (!enabled || !cfg.account || !account.isAttached) return;
				if (event === "turn_end" || event === "model_select") {
					void account
						.pump(true)
						.then(() => noteLogin(ctx))
						.catch(() => {});
				} else noteLogin(ctx);
			});
		}

		// pi replaces extensions on `/reload` without tearing the old module down; an
		// interval still calling into an invalidated ctx would be an uncaught exception.
		pi.on("session_shutdown", () => {
			account.dispose();
			lastCtx = undefined;
		});

		pi.registerCommand("footer", {
			description: "Footer: on | off | account (refresh the account chip)",
			getArgumentCompletions: (prefix: string) => {
				const items = ["on", "off", "account"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const arg = (args ?? "").trim().toLowerCase();
				lastCtx = ctx;
				if (arg === "account") {
					// A blank margin is either "this provider publishes nothing" or "the
					// probe failed", and only this tells them apart.
					if (!cfg.account) {
						ctx.ui.notify("footer: the account chip is off (settings.json footer.account)", "info");
						return;
					}
					const provider = ctx.model?.provider;
					if (!provider || !PROBES[provider]) {
						ctx.ui.notify(`footer: no account probe for ${provider ?? "no model"}`, "info");
						return;
					}
					await account.refresh();
					const value = account.peek();
					if (value) ctx.ui.notify(`footer: ${provider} ${value.label} ${value.value}`, "info");
					else ctx.ui.notify(`footer: ${provider} — ${account.error ?? "no quota in the response"}`, "warning");
					return;
				}
				if (arg !== "" && arg !== "on" && arg !== "off") {
					ctx.ui.notify("footer: on | off | account", "info");
					return;
				}
				enabled = arg === "off" ? false : arg === "on" ? true : !enabled;
				install(ctx);
				ctx.ui.notify(enabled ? "footer: toolkit two-line footer" : "footer: pi's built-in", "info");
			},
		});
	},
};

export default module;
