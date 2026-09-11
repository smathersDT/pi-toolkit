/**
 * GitHub Copilot's own model catalogue (`GET /models` with the Copilot client
 * headers), mapped to pi model entries. Ported from the old model-sync
 * extension without its dated price corrections: pi now reports cache-write
 * tokens separately on the responses API, so the endpoint's published rates
 * are used as they are.
 */
import { validCost, type Cost } from "./prices.ts";

/** The client identity Copilot expects. Bump the versions here and re-run /model-sync. */
export const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": "2026-06-01",
};

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const FETCH_TIMEOUT_MS = 30_000;

export interface TokenPrices {
	input_price?: number;
	output_price?: number;
	cache_price?: number;
	cache_read_price?: number;
	cache_write_price?: number;
}

export interface RawCopilotModel {
	id: string;
	name?: string;
	capabilities?: {
		limits?: { max_context_window_tokens?: number; max_output_tokens?: number; max_prompt_tokens?: number };
		supports?: {
			adaptive_thinking?: boolean;
			max_thinking_budget?: number;
			reasoning_effort?: string[];
			tool_calls?: boolean;
			vision?: boolean;
		};
	};
	policy?: { state?: string };
	billing?: { token_prices?: { batch_size?: number; default?: TokenPrices; long_context?: TokenPrices } };
	model_picker_enabled?: boolean;
	supported_endpoints?: string[];
	vendor?: string;
}

export interface CopilotEntry {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	maxTokens: number;
	cost: Cost;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

/** The token carries the API host it was issued for; default to the individual endpoint. */
export function copilotBaseUrl(token: string): string {
	const match = token.match(/proxy-ep=([^;]+)/);
	return match ? `https://${match[1].replace(/^proxy\./, "api.")}` : "https://api.individual.githubcopilot.com";
}

/** Fetch the catalogue rows. Throws on HTTP or shape errors so the caller keeps the old block. */
export async function fetchCopilotCatalogue(token: string, fetchImpl: typeof fetch): Promise<RawCopilotModel[]> {
	const response = await fetchImpl(`${copilotBaseUrl(token)}/models`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...COPILOT_HEADERS },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} from Copilot /models`);
	const payload = (await response.json()) as { data?: unknown };
	const data = payload?.data;
	if (!Array.isArray(data) || data.some((m) => !m || typeof m !== "object" || typeof (m as RawCopilotModel).id !== "string" || !(m as RawCopilotModel).id)) {
		throw new Error("invalid Copilot catalogue; previous block kept");
	}
	return data as RawCopilotModel[];
}

/** Rows a user can pick and that can call tools. */
export function selectable(m: RawCopilotModel): boolean {
	return m.model_picker_enabled === true && m.policy?.state !== "disabled" && m.capabilities?.supports?.tool_calls !== false;
}

/** Copilot quotes cents per `batch_size` tokens; pi wants dollars per million. Missing → 0. */
export function centsToPerMillion(price: number | undefined, batchSize = 1_000_000): number {
	if (typeof price !== "number" || !Number.isFinite(price) || typeof batchSize !== "number" || batchSize <= 0) return 0;
	return Number(((price / 100) * (1_000_000 / batchSize)).toFixed(9));
}

function inferApi(endpoints: string[] | undefined, id: string): string {
	const eps = new Set(endpoints ?? []);
	if (eps.has("/v1/messages")) return "anthropic-messages";
	if (eps.has("/responses")) return "openai-responses";
	if (eps.has("/chat/completions")) return "openai-completions";
	if (id.startsWith("claude-")) return "anthropic-messages";
	if (id.startsWith("gpt-5")) return "openai-responses";
	return "openai-completions";
}

function isReasoning(m: RawCopilotModel): boolean {
	const supports = m.capabilities?.supports ?? {};
	if (m.id.startsWith("kimi-") || (m.vendor ?? "").toLowerCase().includes("moonshot")) return true;
	if (supports.adaptive_thinking === true || typeof supports.max_thinking_budget === "number") return true;
	return Array.isArray(supports.reasoning_effort) && supports.reasoning_effort.length > 0;
}

function thinkingLevelMap(m: RawCopilotModel, api: string, compat: Record<string, unknown>): Record<string, string | null> | undefined {
	const supported = new Set(m.capabilities?.supports?.reasoning_effort ?? []);
	if (supported.size === 0) return { off: null };
	if (api === "openai-completions" && compat.supportsReasoningEffort === false && compat.thinkingFormat !== "deepseek") return undefined;
	const map: Record<string, string | null> = {
		off: supported.has("none") || supported.has("off") ? "none" : null,
		minimal: supported.has("minimal") ? "minimal" : supported.has("low") ? "low" : null,
		low: supported.has("low") ? "low" : null,
		medium: supported.has("medium") ? "medium" : null,
		high: supported.has("high") ? "high" : null,
	};
	if (supported.has("xhigh")) map.xhigh = api === "anthropic-messages" && supported.has("max") ? "max" : "xhigh";
	else if (supported.has("max")) map.xhigh = "max";
	else map.xhigh = null;
	return map;
}

function buildCompat(m: RawCopilotModel, api: string): Record<string, unknown> {
	const compat: Record<string, unknown> = {};
	if (api === "anthropic-messages") {
		if (m.capabilities?.supports?.adaptive_thinking === true) compat.forceAdaptiveThinking = true;
	} else if (api === "openai-completions") {
		if (/^(gemini-|gpt-|claude-)/.test(m.id)) Object.assign(compat, { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false });
		if (m.id.startsWith("kimi-")) {
			Object.assign(compat, { thinkingFormat: "deepseek", supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", supportsStrictMode: false });
		}
	}
	return compat;
}

/** One catalogue row → one models.json entry, or undefined when its prices are not sane. */
export function mapCopilotModel(m: RawCopilotModel): CopilotEntry | undefined {
	const limits = m.capabilities?.limits ?? {};
	const supports = m.capabilities?.supports ?? {};
	const api = inferApi(m.supported_endpoints, m.id);
	const reasoning = isReasoning(m);
	const compat = buildCompat(m, api);
	const prices = m.billing?.token_prices;
	const rates = prices?.default ?? prices?.long_context;
	const batch = prices?.batch_size || 1_000_000;
	const cost: Cost = rates
		? {
				input: centsToPerMillion(rates.input_price, batch),
				output: centsToPerMillion(rates.output_price, batch),
				cacheRead: centsToPerMillion(rates.cache_price ?? rates.cache_read_price, batch),
				cacheWrite: centsToPerMillion(rates.cache_write_price, batch),
			}
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	if (!validCost(cost)) return undefined;
	const contextWindow = limits.max_context_window_tokens;
	const maxTokens = limits.max_output_tokens;
	const entry: CopilotEntry = {
		id: m.id,
		name: typeof m.name === "string" && m.name ? m.name : m.id,
		api,
		reasoning,
		input: supports.vision ? ["text", "image"] : ["text"],
		// Deliberately not max_prompt_tokens: that is a context limit, not an output cap.
		contextWindow: saneCount(contextWindow) ? contextWindow : 128_000,
		maxTokens: saneCount(maxTokens) ? maxTokens : DEFAULT_MAX_OUTPUT_TOKENS,
		cost,
	};
	const levels = reasoning ? thinkingLevelMap(m, api, compat) : undefined;
	if (levels) entry.thinkingLevelMap = levels;
	if (Object.keys(compat).length > 0) entry.compat = compat;
	return entry;
}

function saneCount(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 100_000_000;
}
