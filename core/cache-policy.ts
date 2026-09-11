/**
 * How long a provider keeps a prompt-cache entry alive, per route.
 *
 * A cache read refreshes the entry for free; a request that arrives after the
 * entry expired re-writes the whole prefix at the cache-write rate. The keepalive
 * module uses `checkInSeconds` to decide when a long tool call should hand
 * control back so the model can send a cheap request that keeps the prefix warm.
 *
 * `null` means "no fixed lifetime is known": the tool blocks like it always did.
 */
export interface CacheModelLike {
	provider?: string;
	id?: string;
	baseUrl?: string;
	compat?: { supportsLongCacheRetention?: boolean };
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface CachePolicy {
	/** Send a request before this many seconds of idle to keep the prefix warm. */
	checkInSeconds: number | null;
	/** Why. Shown by `/toolkit keepalive`. */
	note: string;
}

const isOpenAIModel = (id = ""): boolean => /^(gpt-|o\d(?:[.-]|$)|codex(?:[.-]|$))/i.test(id);
const isClaude = (id = ""): boolean => /claude/i.test(id);

function hostIs(baseUrl: string | undefined, host: string): boolean {
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === host;
	} catch {
		return false;
	}
}

/** GPT-5.6 and newer get a 30-minute cache on the direct OpenAI API. */
export function isModernOpenAI(id = ""): boolean {
	const m = /^gpt-(\d+)(?:\.(\d+))?(?:[-.]|$)/i.exec(id);
	return !!m && (+m[1] > 5 || (+m[1] === 5 && +(m[2] ?? 0) >= 6));
}

export function cachePolicyFor(model: CacheModelLike | undefined, overrides: Record<string, number> = {}): CachePolicy {
	if (!model) return { checkInSeconds: null, note: "no model selected" };
	const key = `${model.provider ?? ""}/${model.id ?? ""}`;
	if (key in overrides) {
		const ttl = overrides[key];
		return ttl > 0 ? { checkInSeconds: ttl, note: `configured override (${ttl}s)` } : { checkInSeconds: null, note: "check-ins disabled by override" };
	}
	const provider = model.provider ?? "";
	const id = model.id ?? "";

	if (provider === "anthropic" && isClaude(id)) {
		return { checkInSeconds: 300, note: "direct Anthropic: 5-minute cache (1 hour is a paid option)" };
	}
	if (provider === "github-copilot") {
		if (/^kimi/i.test(id)) return { checkInSeconds: null, note: "Copilot Kimi: provider-managed cache, no known TTL" };
		if (isClaude(id)) return { checkInSeconds: 300, note: "Copilot Claude: observed 5-minute cache" };
		if (isOpenAIModel(id)) return { checkInSeconds: 300, note: "Copilot OpenAI: observed 5-8 minutes, protect at 5" };
		return { checkInSeconds: null, note: "Copilot: unknown model family" };
	}
	if (provider === "openai" && hostIs(model.baseUrl, "api.openai.com") && isOpenAIModel(id)) {
		if (isModernOpenAI(id)) return { checkInSeconds: 1800, note: "direct OpenAI GPT-5.6+: 30-minute cache" };
		return { checkInSeconds: 300, note: "direct OpenAI legacy: 5-10 minute cache" };
	}
	if (provider === "openai-codex" && isOpenAIModel(id)) {
		// pi closes an idle Codex WebSocket after ~300s; yield before that.
		return isModernOpenAI(id)
			? { checkInSeconds: 300, note: "Codex: protect the connection before pi's 300s WebSocket idle close" }
			: { checkInSeconds: null, note: "Codex legacy model: no automatic check-ins" };
	}
	if (provider === "deepseek" && hostIs(model.baseUrl, "api.deepseek.com")) {
		return { checkInSeconds: null, note: "DeepSeek: best-effort disk cache lasting hours; no check-ins needed" };
	}
	if (/gemini|google/i.test(provider)) {
		return { checkInSeconds: null, note: "Gemini: implicit caching, no fixed TTL" };
	}
	return { checkInSeconds: null, note: "unknown route: no check-ins" };
}

/** Does keeping the cache warm pay? Only when a rebuild clearly costs more than a read. */
export function rebuildIsExpensive(model: CacheModelLike | undefined): boolean {
	const cost = model?.cost;
	if (!cost || !cost.cacheRead || !cost.input) return false;
	return cost.input / cost.cacheRead >= 3;
}
