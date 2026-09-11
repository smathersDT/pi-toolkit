/**
 * model-sync — keep pi's catalogue prices honest.
 *
 * Once a day, in the background after session_start, the official price pages
 * of the providers this pi is logged into (DeepSeek, OpenAI / Codex, Anthropic)
 * and Copilot's own catalogue are fetched, validated against the catalogue pi
 * already holds, and merged into <agent-dir>/models.json (cost only). The
 * registry is refreshed in place and the session is told when the model it is
 * using changed price. DeepSeek's peak/off-peak bands are re-applied as the UTC
 * clock crosses them.
 *
 *   /model-sync [provider] [--verify]   run now, report per provider
 *   /model-sync prices                  the catalogue's prices, cheapest first
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";
import { readJson } from "../../core/paths.ts";
import { formatDuration, plural } from "../../core/text.ts";
import { modelsJsonPath } from "./merge.ts";
import { currentBand, type Schedule } from "./parsers.ts";
import { fmtRate, movedRates, type Cost } from "./prices.ts";
import { isDue, readState } from "./state.ts";
import { applyDeepSeekBand, deepSeekBandState, SYNC_PROVIDERS, syncProviders, type CatalogueModel, type PriceChange, type ProviderResult, type SyncOutcome } from "./sync.ts";

const ID = "model-sync";
const DEFAULTS = { intervalHours: 24 };

const VERIFY_PROMPT = "Reply with exactly OK.";
const VERIFY_MAX_TOKENS = 32;
const VERIFY_TIMEOUT_MS = 20_000;

export interface ModelSyncDeps {
	/** Injected in tests so nothing hits the network. */
	fetchImpl?: typeof fetch;
	now?: () => Date;
}

type Change = PriceChange & { provider: string };

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `<provider>/<id> price moved: input $X → $Y, output $A → $B per 1M` (+ cache rates when only those moved). */
export function moveLine(change: Change): string {
	const { provider, id, before, after } = change;
	const parts = [`input ${fmtRate(before?.input)} → ${fmtRate(after.input)}`, `output ${fmtRate(before?.output)} → ${fmtRate(after.output)}`];
	for (const k of movedRates(before, after)) {
		if (k === "cacheRead") parts.push(`cached ${fmtRate(before?.cacheRead)} → ${fmtRate(after.cacheRead)}`);
		if (k === "cacheWrite") parts.push(`cache write ${fmtRate(before?.cacheWrite)} → ${fmtRate(after.cacheWrite)}`);
	}
	return `${provider}/${id} price moved: ${parts.join(", ")} per 1M`;
}

export function resultLine(r: ProviderResult): string {
	const status = r.skipped
		? `skipped: ${r.skipped}`
		: !r.ok
			? `failed: ${r.error ?? "unknown error"}`
			: r.changed.length
				? `updated ${plural(r.changed.length, "price")} (${r.changed.map((c) => c.id).join(", ")})`
				: `unchanged (${r.matched} matched)`;
	return `${r.provider.padEnd(15)} ${status}${r.note ? ` — ${r.note}` : ""}`;
}

export function createModelSyncModule(deps: ModelSyncDeps = {}): ToolkitModule {
	return {
		id: ID,
		label: "Model & pricing sync",
		description: "Daily refresh of official model prices into models.json; /model-sync",
		default: true,
		order: 80,
		child: "never",
		setup(pi: ExtensionAPI, kit: Toolkit) {
			const cfg = kit.config(ID, DEFAULTS);
			const agentDir = kit.paths.agentDir;
			const now = deps.now ?? (() => new Date());
			let autoTimer: ReturnType<typeof setTimeout> | undefined;
			let running: Promise<SyncOutcome> | undefined;
			/** In-memory copy of the DeepSeek band table, so the per-request check costs no disk read. */
			let band: { schedule: Schedule; applied?: string } | undefined;

			const offline = () => process.env.PI_OFFLINE === "1";
			const autoOff = () => (process.env.PI_TOOLKIT_MODEL_SYNC ?? "").trim().toLowerCase() === "off";

			const catalogue = (ctx: any): CatalogueModel[] => {
				try {
					return (ctx.modelRegistry?.getAll?.() ?? []).map((m: any) => ({ provider: m.provider, id: m.id, cost: m.cost }));
				} catch {
					return [];
				}
			};
			const authenticated = (ctx: any): Set<string> => {
				try {
					return new Set((ctx.modelRegistry?.getAvailable?.() ?? []).map((m: any) => String(m.provider)));
				} catch {
					return new Set();
				}
			};

			/** The Copilot bearer via pi (refreshed under its lock), else the one on disk. Undefined without a login. */
			const copilotToken = async (ctx: any): Promise<string | undefined> => {
				const creds = readJson<Record<string, any>>(join(agentDir, "auth.json"), {})["github-copilot"];
				if (!creds || typeof creds !== "object") return undefined;
				try {
					const fresh = await ctx.modelRegistry?.getApiKeyForProvider?.("github-copilot");
					if (typeof fresh === "string" && fresh) return fresh;
				} catch {
					// fall through to the stored token
				}
				return typeof creds.access === "string" && creds.access ? creds.access : undefined;
			};

			const reloadBand = () => {
				band = deepSeekBandState(agentDir);
			};

			/** Refresh pi's registry from the new file and tell the session when its own model moved. */
			const announce = async (ctx: any, changes: Change[], written: boolean) => {
				if (!written) return;
				const registry = ctx.modelRegistry;
				let restart = false;
				let loadError: string | undefined;
				if (typeof registry?.refresh === "function") {
					try {
						await registry.refresh({ allowNetwork: false });
						const err = registry.getError?.();
						if (typeof err === "string" && err) loadError = err;
					} catch (error) {
						loadError = message(error);
					}
				} else restart = true;
				const current = ctx.model;
				const mine = current ? changes.find((c) => c.provider === current.provider && c.id === current.id) : undefined;
				if (mine) ctx.ui?.notify?.(`${moveLine(mine)}${restart ? " (restart pi to bill at the new rates)" : ""}`, "info");
				if (loadError) ctx.ui?.notify?.(`model-sync: models.json did not load: ${loadError}`, "warning");
				else if (restart && !mine && changes.length) kit.log(ID, "registry has no refresh(); new prices load on restart");
			};

			const runSync = (ctx: any, providers: string[]): Promise<SyncOutcome> => {
				if (running) return running;
				running = (async () => {
					const token = providers.includes("github-copilot") ? await copilotToken(ctx) : undefined;
					const outcome = await syncProviders({
						agentDir,
						catalogue: catalogue(ctx),
						providers,
						fetchImpl: deps.fetchImpl,
						now: now(),
						copilotToken: token,
						log: (m) => kit.log(ID, m),
					});
					reloadBand();
					for (const r of outcome.results) kit.log(ID, resultLine(r));
					await announce(
						ctx,
						outcome.results.flatMap((r) => r.changed.map((c) => ({ ...c, provider: r.provider }))),
						outcome.written,
					);
					return outcome;
				})().finally(() => {
					running = undefined;
				});
				return running;
			};

			/** DeepSeek: when the UTC clock crossed a band boundary, write that band's prices. */
			const bandCheck = async (ctx: any) => {
				if (!band || currentBand(band.schedule, now()) === band.applied) return;
				try {
					const applied = applyDeepSeekBand(agentDir, catalogue(ctx), now());
					reloadBand();
					if (!applied) return;
					if (applied.error) {
						kit.log(ID, `deepseek band not applied: ${applied.error}`);
						return;
					}
					kit.log(ID, `deepseek ${applied.band} band applied (${applied.changed.length} moved)`);
					await announce(
						ctx,
						applied.changed.map((c) => ({ ...c, provider: "deepseek" })),
						applied.written,
					);
				} catch (error) {
					kit.log(ID, `band check failed: ${message(error)}`);
				}
			};

			pi.on("session_start", async (_event, ctx) => {
				try {
					reloadBand();
					await bandCheck(ctx);
					if (offline() || autoOff() || autoTimer || running) return;
					const auth = authenticated(ctx);
					const state = readState(agentDir);
					const every = Math.max(1, Number(cfg.intervalHours) || DEFAULTS.intervalHours) * 3_600_000;
					const due = SYNC_PROVIDERS.filter((p) => auth.has(p) && isDue(state, p, now().getTime(), every));
					if (due.length === 0) return;
					autoTimer = setTimeout(() => {
						autoTimer = undefined;
						runSync(ctx, due).catch((error) => kit.log(ID, `auto sync failed: ${message(error)}`));
					}, 0);
					autoTimer.unref?.();
				} catch (error) {
					kit.log(ID, `session_start: ${message(error)}`);
				}
			});

			pi.on("model_select", async (_event, ctx) => {
				await bandCheck(ctx);
			});

			pi.on("before_provider_request", async (_event, ctx) => {
				await bandCheck(ctx);
				return undefined;
			});

			pi.on("session_shutdown", () => {
				if (autoTimer) clearTimeout(autoTimer);
				autoTimer = undefined;
			});

			const printPrices = (ctx: any) => {
				let models: any[] = [];
				try {
					models = ctx.modelRegistry?.getAvailable?.() ?? [];
				} catch {
					models = [];
				}
				const sorted = [...models].sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0) || (a.cost?.output ?? 0) - (b.cost?.output ?? 0) || `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
				const lines = sorted.map((m) => {
					const cost: Partial<Cost> = m.cost ?? {};
					return `${`${m.provider}/${m.id}`.padEnd(44)} ${fmtRate(cost.input).padStart(8)} ${fmtRate(cost.cacheRead).padStart(8)} ${fmtRate(cost.output).padStart(8)}${cost.tiers?.length ? " +tiers" : ""}`;
				});
				kit.print("model-sync prices", [`${plural(sorted.length, "available model")}, $ per 1M tokens: input · cached · output`], lines.length ? lines : ["no models with configured auth"]);
			};

			const verify = async (ctx: any, providers: string[]) => {
				const registry = ctx.modelRegistry;
				if (typeof registry?.complete !== "function") {
					kit.print("model-sync verify", [], ["not supported: this pi's model registry has no complete()"], "error");
					return;
				}
				let models: any[] = [];
				try {
					models = (registry.getAvailable?.() ?? []).filter((m: any) => providers.includes(m.provider));
				} catch {
					models = [];
				}
				ctx.ui?.notify?.(`model-sync: verifying ${plural(models.length, "model")} with one tiny request each (uses quota)…`, "info");
				const lines: string[] = [];
				let failed = 0;
				for (const m of models) {
					const started = Date.now();
					const label = `${m.provider}/${m.id}`.padEnd(44);
					try {
						const reply = await registry.complete(
							m,
							{ messages: [{ role: "user", content: VERIFY_PROMPT, timestamp: Date.now() }] },
							{ maxTokens: VERIFY_MAX_TOKENS, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
						);
						const text = (reply?.content ?? [])
							.filter((c: any) => c?.type === "text" && typeof c.text === "string")
							.map((c: any) => c.text)
							.join("")
							.trim();
						const ok = reply && reply.stopReason !== "error" && reply.stopReason !== "aborted" && !reply.errorMessage;
						if (!ok) failed++;
						lines.push(`${label} ${ok ? `ok ${formatDuration(Date.now() - started)}${text ? ` ${JSON.stringify(text.slice(0, 24))}` : ""}` : `failed: ${reply?.errorMessage ?? reply?.stopReason ?? "no reply"}`}`);
					} catch (error) {
						failed++;
						lines.push(`${label} failed: ${message(error)}`);
					}
				}
				kit.print("model-sync verify", [`${plural(models.length, "model")}, ${VERIFY_MAX_TOKENS} output tokens each, ${VERIFY_TIMEOUT_MS / 1000}s timeout`], lines.length ? lines : ["no available models for the selected providers"], failed ? "error" : "ok");
			};

			pi.registerCommand("model-sync", {
				description: "Refresh model prices from the official pages: /model-sync [provider] [--verify] | prices",
				getArgumentCompletions: (prefix: string) => {
					const items = ["prices", ...SYNC_PROVIDERS, "--verify"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
					return items.length ? items : null;
				},
				handler: async (args: string, ctx: any) => {
					try {
						const tokens = args.trim().split(/\s+/).filter(Boolean);
						const doVerify = tokens.includes("--verify");
						const words = tokens.filter((t) => !t.startsWith("--"));
						if (words[0] === "prices") return printPrices(ctx);
						const head = [`models.json: ${modelsJsonPath(agentDir)}`];
						const provider = words[0];
						if (provider && !SYNC_PROVIDERS.includes(provider)) {
							kit.print("model-sync", head, [`unknown provider "${provider}"; one of: ${SYNC_PROVIDERS.join(", ")}`], "error");
							return;
						}
						if (offline()) {
							kit.print("model-sync", head, ["offline (PI_OFFLINE=1): nothing fetched"], "error");
							return;
						}
						const auth = authenticated(ctx);
						const providers = provider ? [provider] : SYNC_PROVIDERS.filter((p) => auth.has(p));
						if (providers.length === 0) {
							kit.print("model-sync", head, [`no authenticated provider among ${SYNC_PROVIDERS.join(", ")}; name one to force it`], "error");
							return;
						}
						const outcome = await runSync(ctx, providers);
						const lines = outcome.results.map(resultLine);
						const failed = outcome.results.some((r) => !r.ok && !r.skipped);
						head.push(outcome.written ? "written (previous file kept as models.json.bak.*)" : outcome.writeError ? `not written: ${outcome.writeError}` : "no changes to write");
						kit.print("model-sync", head, lines, failed ? "error" : "ok");
						if (doVerify) await verify(ctx, providers);
					} catch (error) {
						kit.print("model-sync", [], [`failed: ${message(error)}`], "error");
					}
				},
			});
		},
	};
}

const module: ToolkitModule = createModelSyncModule();
export default module;
