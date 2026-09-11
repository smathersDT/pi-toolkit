/**
 * Is a local model server actually up?
 *
 * A `local` provider (llama.cpp, LM Studio, Ollama) is "available" to pi's
 * registry whenever models.json lists it, whether or not the server runs. A
 * child spawned against a dead server wastes a turn and fails with a socket
 * error, so the subagent module probes `<baseUrl>/models` first and falls back
 * to the role's `fallback` (or the next cheap model) when nothing answers.
 * pi-free; `fetchImpl` is injectable for tests.
 */
export interface ReachModel {
	provider?: string;
	id?: string;
	baseUrl?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

export function isLocalModel(model: ReachModel | undefined): boolean {
	if (!model) return false;
	if (model.provider === "local" || model.provider === "llama.cpp" || model.provider === "ollama" || model.provider === "lmstudio") return true;
	if (!model.baseUrl) return false;
	try {
		return LOCAL_HOSTS.has(new URL(model.baseUrl).hostname);
	} catch {
		return false;
	}
}

type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ status: number }>;

const cache = new Map<string, { at: number; ok: boolean }>();
const CACHE_MS = 30_000;

/** GET `<baseUrl>/models` with a short timeout; any HTTP answer counts as reachable. */
export async function probeReachable(baseUrl: string | undefined, timeoutMs = 1500, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike, now = Date.now()): Promise<boolean> {
	if (!baseUrl) return true;
	const hit = cache.get(baseUrl);
	if (hit && now - hit.at < CACHE_MS) return hit.ok;
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let ok = false;
	try {
		const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
		ok = typeof res?.status === "number";
	} catch {
		ok = false;
	} finally {
		clearTimeout(timer);
	}
	cache.set(baseUrl, { at: now, ok });
	return ok;
}

export function resetReachCache(): void {
	cache.clear();
}
