/**
 * The sync itself, pi-free: given the catalogue pi currently holds and a fetch,
 * refresh each requested provider independently, merge into models.json in one
 * write, stamp state.json and append the ledger.
 *
 * Prices are only ever written for ids that exist in the catalogue (the Copilot
 * block, which is that provider's catalogue, is the one exception).
 */
import { fetchCopilotCatalogue, mapCopilotModel, selectable, type CopilotEntry } from "./copilot.ts";
import { applyModelsJson, mergeCopilotModels, mergeCosts, modelsJsonPath } from "./merge.ts";
import {
	ANTHROPIC_URL,
	DEEPSEEK_ALIASES,
	DEEPSEEK_URL,
	OPENAI_URL,
	anthropicIdMatches,
	bandRates,
	currentBand,
	parseAnthropic,
	parseDeepSeek,
	parseOpenAI,
	type BandName,
	type OpenAIPrice,
} from "./parsers.ts";
import { costMoved, type Cost } from "./prices.ts";
import { appendLedger, readState, writeState, type DeepSeekState } from "./state.ts";

export const SYNC_PROVIDERS: string[] = ["deepseek", "openai", "openai-codex", "anthropic", "github-copilot"];

export interface CatalogueModel {
	provider: string;
	id: string;
	cost?: Partial<Cost>;
}

export interface PriceChange {
	id: string;
	before?: Partial<Cost>;
	after: Cost;
}

export interface ProviderResult {
	provider: string;
	ok: boolean;
	/** Ids whose billed rates moved. */
	changed: PriceChange[];
	/** Ids the source priced. */
	matched: number;
	error?: string;
	/** Not attempted, and why. */
	skipped?: string;
	note?: string;
}

export interface SyncOptions {
	agentDir: string;
	catalogue: CatalogueModel[];
	providers: string[];
	fetchImpl?: typeof fetch;
	now?: Date;
	copilotToken?: string;
	log?: (message: string) => void;
}

export interface SyncOutcome {
	results: ProviderResult[];
	written: boolean;
	path: string;
	writeError?: string;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 2_000_000;
const USER_AGENT = "pi-toolkit model-sync";

type Priced = Map<string, Cost>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function getText(fetchImpl: typeof fetch, url: string): Promise<string> {
	const response = await fetchImpl(url, {
		headers: { Accept: "text/markdown, text/html;q=0.9", "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const text = await response.text();
	if (text.length > MAX_BYTES) throw new Error(`response too large (${text.length} bytes)`);
	return text;
}

function diff(models: CatalogueModel[], priced: Priced): PriceChange[] {
	const changed: PriceChange[] = [];
	for (const m of models) {
		const after = priced.get(m.id);
		if (after && costMoved(m.cost, after)) changed.push({ id: m.id, before: m.cost, after });
	}
	return changed;
}

/** DeepSeek page prices for the catalogue's ids (direct or via the alias table), in one band. */
export function deepSeekPrices(table: Pick<DeepSeekState, "models">, band: BandName, models: CatalogueModel[]): Priced {
	const priced: Priced = new Map();
	for (const m of models) {
		const pageId = table.models[m.id] ? m.id : DEEPSEEK_ALIASES[m.id];
		if (pageId && table.models[pageId]) priced.set(m.id, bandRates(table.models[pageId], band));
	}
	return priced;
}

function openAIPrices(page: Record<string, OpenAIPrice>, models: CatalogueModel[], log: (m: string) => void): Priced {
	const priced: Priced = new Map();
	for (const m of models) {
		const p = page[m.id.toLowerCase()];
		if (!p) continue;
		const cost: Cost = { ...p.rates };
		if (p.long) {
			// A threshold comes from the row ("<272K context length") or from the tier pi already
			// knows; with neither, the long rates are not applied rather than guessed.
			const threshold = p.threshold ?? m.cost?.tiers?.find((t) => t.inputTokensAbove > 0)?.inputTokensAbove;
			if (threshold) cost.tiers = [{ inputTokensAbove: threshold, ...p.long }];
			else log(`${m.provider}/${m.id}: long-context rates published without a threshold; not applied`);
		}
		priced.set(m.id, cost);
	}
	return priced;
}

function anthropicPrices(page: Record<string, Cost>, models: CatalogueModel[]): Priced {
	const priced: Priced = new Map();
	const slugs = Object.keys(page);
	for (const m of models) {
		const slug = slugs.find((s) => anthropicIdMatches(s, m.id));
		if (slug) priced.set(m.id, { ...page[slug] });
	}
	return priced;
}

/** Refresh the requested providers. Each fails alone; one models.json write at the end. */
export async function syncProviders(opts: SyncOptions): Promise<SyncOutcome> {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	const now = opts.now ?? new Date();
	const log = opts.log ?? (() => {});
	const state = readState(opts.agentDir);
	const want = new Set(opts.providers);
	const results: ProviderResult[] = [];
	const writes: Array<(config: { providers: Record<string, any> }) => void> = [];
	const models = (provider: string) => opts.catalogue.filter((m) => m.provider === provider);
	let deepseekBand: BandName | undefined;

	const priceProvider = async (provider: string, work: () => Promise<{ priced: Priced; note?: string }>) => {
		try {
			const { priced, note } = await work();
			const changed = diff(models(provider), priced);
			if (priced.size) writes.push((config) => mergeCosts(config, provider, Object.fromEntries(priced)));
			results.push({ provider, ok: true, changed, matched: priced.size, note });
		} catch (error) {
			results.push({ provider, ok: false, changed: [], matched: 0, error: message(error) });
		}
	};

	if (want.has("deepseek")) {
		await priceProvider("deepseek", async () => {
			const parsed = parseDeepSeek(await getText(fetchImpl, DEEPSEEK_URL));
			if (!parsed) throw new Error("unrecognised page layout; prices kept");
			deepseekBand = currentBand(parsed.schedule, now);
			state.deepseek = { fetchedAt: now.toISOString(), models: parsed.models, schedule: parsed.schedule, applied: state.deepseek?.applied };
			return { priced: deepSeekPrices(parsed, deepseekBand, models("deepseek")), note: `${deepseekBand} band` };
		});
	}

	const openaiTargets = ["openai", "openai-codex"].filter((p) => want.has(p));
	if (openaiTargets.length) {
		let page: Record<string, OpenAIPrice> | undefined;
		let failure = "unrecognised page layout; prices kept";
		try {
			page = parseOpenAI(await getText(fetchImpl, OPENAI_URL));
		} catch (error) {
			failure = message(error);
		}
		for (const provider of openaiTargets) {
			await priceProvider(provider, async () => {
				if (!page) throw new Error(failure);
				return { priced: openAIPrices(page, models(provider), log) };
			});
		}
	}

	if (want.has("anthropic")) {
		await priceProvider("anthropic", async () => {
			const parsed = parseAnthropic(await getText(fetchImpl, ANTHROPIC_URL));
			if (!parsed) throw new Error("unrecognised page layout; prices kept");
			return { priced: anthropicPrices(parsed, models("anthropic")) };
		});
	}

	if (want.has("github-copilot")) {
		if (!opts.copilotToken) {
			results.push({ provider: "github-copilot", ok: false, changed: [], matched: 0, skipped: "no Copilot login in auth.json" });
		} else {
			try {
				const rows = (await fetchCopilotCatalogue(opts.copilotToken, fetchImpl)).filter(selectable);
				const entries: CopilotEntry[] = [];
				for (const row of rows) {
					const entry = mapCopilotModel(row);
					if (entry) entries.push(entry);
					else log(`github-copilot/${row.id}: prices out of range; row dropped`);
				}
				if (entries.length === 0) throw new Error("catalogue has no selectable models; block kept");
				const known = new Map(models("github-copilot").map((m) => [m.id, m]));
				const changed = entries.flatMap((e) => {
					const before = known.get(e.id)?.cost;
					return before && costMoved(before, e.cost) ? [{ id: e.id, before, after: e.cost }] : [];
				});
				const added = entries.filter((e) => !known.has(e.id)).length;
				writes.push((config) => mergeCopilotModels(config, entries));
				results.push({ provider: "github-copilot", ok: true, changed, matched: entries.length, note: added ? `${added} new` : undefined });
			} catch (error) {
				results.push({ provider: "github-copilot", ok: false, changed: [], matched: 0, error: message(error) });
			}
		}
	}

	const path = modelsJsonPath(opts.agentDir);
	let written = false;
	let writeError: string | undefined;
	if (writes.length) {
		const applied = applyModelsJson(opts.agentDir, (config) => {
			for (const write of writes) write(config);
		});
		written = applied.written;
		writeError = applied.error;
		if (writeError) {
			for (const r of results) {
				if (r.ok) {
					r.ok = false;
					r.error = `models.json not written: ${writeError}`;
				}
			}
		}
	}
	if (state.deepseek && deepseekBand && results.some((r) => r.provider === "deepseek" && r.ok)) state.deepseek.applied = deepseekBand;

	const t = now.toISOString();
	for (const r of results) {
		if (r.skipped) continue;
		const stamp = { ...(state.runs[r.provider] ?? {}), attempt: t };
		if (r.ok) {
			stamp.ok = t;
			delete stamp.error;
		} else stamp.error = r.error;
		state.runs[r.provider] = stamp;
		appendLedger(opts.agentDir, { provider: r.provider, ok: r.ok, changed: r.changed.map((c) => c.id), error: r.error }, now);
	}
	writeState(opts.agentDir, state);
	return { results, written, path, writeError };
}

export interface BandApply {
	band: BandName;
	changed: PriceChange[];
	written: boolean;
	error?: string;
}

/** The DeepSeek band table on disk, for the cheap per-request check. */
export function deepSeekBandState(agentDir: string): { schedule: DeepSeekState["schedule"]; applied?: BandName } | undefined {
	const ds = readState(agentDir).deepseek;
	return ds ? { schedule: ds.schedule, applied: ds.applied } : undefined;
}

/** Write the current UTC band's DeepSeek prices when models.json holds the other band. */
export function applyDeepSeekBand(agentDir: string, catalogue: CatalogueModel[], now = new Date()): BandApply | undefined {
	const state = readState(agentDir);
	const ds = state.deepseek;
	if (!ds) return undefined;
	const band = currentBand(ds.schedule, now);
	if (ds.applied === band) return undefined;
	const models = catalogue.filter((m) => m.provider === "deepseek");
	const priced = deepSeekPrices(ds, band, models);
	let written = false;
	if (priced.size) {
		const applied = applyModelsJson(agentDir, (config) => mergeCosts(config, "deepseek", Object.fromEntries(priced)));
		if (applied.error) return { band, changed: [], written: false, error: applied.error };
		written = applied.written;
	}
	ds.applied = band;
	writeState(agentDir, state);
	return { band, changed: diff(models, priced), written };
}
