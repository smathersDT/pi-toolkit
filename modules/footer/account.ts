/**
 * What the account behind the current model has left — the one number the footer
 * cannot derive from the session.
 *
 *     quota 1311/1500 · 12d        github-copilot, premium interactions
 *     balance $11.09               deepseek, prepaid credit
 *     quota 5h 66% · 2h  7d 88% · 4d   openai-codex, both ChatGPT windows
 *     spent $12.40 mtd             openai, only with OPENAI_ADMIN_KEY
 *
 * One probe per provider, only for providers that publish this; everything else
 * renders blank. pi-free: every dependency (fetch, keys, env, host) arrives through
 * `ProbeDeps`, so `test/account.test.ts` runs under plain node.
 */
import type { Chip, Tone } from "./view.ts";

/** The right-hand chip: the same shape as a status chip, painted the same way. */
export type Account = Pick<Chip, "label" | "value" | "tone">;

export interface ProbeDeps {
	fetch: typeof fetch;
	/**
	 * The key pi resolves for this provider, refreshed and persisted under pi's own
	 * lock. Right for a plain API key; for Copilot this is the half-hour bearer, which
	 * is not what api.github.com accepts — see `copilotProbe`.
	 */
	apiKey(): Promise<string | undefined>;
	/** The provider's raw `auth.json` record, for tokens key resolution does not return. */
	credentials(): Record<string, unknown> | undefined;
	/** An environment variable, for the providers pi can authenticate without a record. */
	env(name: string): string | undefined;
	/** The host the current model actually talks to, so a probe can refuse a proxy. */
	baseUrl(): string | undefined;
}

export type Probe = (deps: ProbeDeps) => Promise<Account | null>;

/**
 * A number, or undefined for anything that is not one. The empty string is
 * deliberately not zero: `Number("")` is `0`, and a blank field would render as a
 * red `$0.00`.
 */
const num = (v: unknown): number | undefined => {
	if (typeof v === "string" && v.trim() === "") return undefined;
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
	return Number.isFinite(n) ? n : undefined;
};

/**
 * `12d`, `today`, or nothing. Counted between UTC midnights so the figure holds
 * still all day and reset day still reads `today` in the afternoon.
 */
export function daysUntil(date: unknown, now: number): string | undefined {
	if (typeof date !== "string") return undefined;
	const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date);
	if (!Number.isFinite(at)) return undefined;
	const DAY = 86_400_000;
	const days = Math.floor(at / DAY) - Math.floor(now / DAY);
	if (days < 0) return undefined;
	return days === 0 ? "today" : `${days}d`;
}

/** Warn with a fifth left, red with a twentieth — the points at which you would change model. */
function toneFor(percentLeft: number | undefined): Tone {
	if (percentLeft === undefined) return "info";
	if (percentLeft <= 5) return "error";
	if (percentLeft <= 20) return "warn";
	return "info";
}

/**
 * `quota_snapshots.premium_interactions` from `/copilot_internal/user`, as a chip.
 * Premium interactions only: `chat` and `completions` are unlimited on every paid
 * plan; the premium counter is the one that runs out mid-week.
 */
export function copilotAccount(body: unknown, now: number): Account | null {
	const snapshots = (body as any)?.quota_snapshots;
	const q = snapshots?.premium_interactions ?? snapshots?.premium_requests;
	if (!q || typeof q !== "object") return null;
	if (q.unlimited === true) return { label: "quota", value: "∞", tone: "info" };

	const remaining = num(q.remaining) ?? num(q.quota_remaining);
	if (remaining === undefined) return null;
	const entitlement = num(q.entitlement);
	const percent = num(q.percent_remaining) ?? (entitlement ? (remaining / entitlement) * 100 : undefined);
	const overage = num(q.overage_count) ?? 0;
	const reset = daysUntil((body as any)?.quota_reset_date, now);

	// Rounded: premium requests bill by a per-model multiplier, so the raw figures
	// are fractional and a footer is no place for two decimals of them.
	const left = Math.round(remaining);
	const over = Math.round(overage);

	// Past the entitlement the count is pinned at zero and what it is costing is the
	// news — only when the plan actually bills for it.
	const head = over > 0 && q.overage_permitted === true ? `+${over} over` : entitlement ? `${left}/${Math.round(entitlement)}` : `${left} left`;
	return {
		label: "quota",
		value: reset ? `${head} · ${reset}` : head,
		tone: over > 0 ? "error" : toneFor(percent),
	};
}

const SYMBOL: Record<string, string> = { USD: "$", CNY: "¥" };

/** `$11.09`, `$1235`, `SGD 40.10` — cents where they matter, dropped where they do not. */
export function formatMoney(amount: number, currency: string): string {
	const text = Math.abs(amount) >= 100 ? String(Math.round(amount)) : amount.toFixed(2);
	const code = currency.toUpperCase();
	return SYMBOL[code] ? `${SYMBOL[code]}${text}` : `${code} ${text}`;
}

/**
 * `/user/balance`, as a chip. Prefers the USD row. `is_available: false` is the
 * interesting case: DeepSeek keeps answering with the balance after it has stopped
 * serving requests on it.
 */
export function deepseekAccount(body: unknown): Account | null {
	const infos = (body as any)?.balance_infos;
	if (!Array.isArray(infos) || infos.length === 0) return null;
	const info = infos.find((b) => String(b?.currency).toUpperCase() === "USD") ?? infos[0];
	const total = num(info?.total_balance);
	if (total === undefined) return null;
	const value = formatMoney(total, String(info?.currency ?? "USD"));
	if ((body as any)?.is_available === false) return { label: "balance", value: `${value} suspended`, tone: "error" };
	// Flat thresholds: a prepaid balance has no ceiling to be a fraction of.
	return { label: "balance", value, tone: total < 1 ? "error" : total < 5 ? "warn" : "info" };
}

async function json(deps: ProbeDeps, url: string, headers: Record<string, string>): Promise<unknown> {
	// Short: this runs on a timer behind a footer. A miss shows the previous value.
	const res = await deps.fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
	return await res.json();
}

/** A credential explicitly refused by the account endpoint; rechecked after login. */
export const LOGIN_EXPIRED: Account = { label: "login", value: "expired · /login", tone: "error" };

/** Only 401 is the provider saying the token itself is no good. */
function isUnauthorized(error: unknown): boolean {
	return error instanceof Error && /^401 /.test(error.message);
}

const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

/**
 * The bare hostname to hang `api.` off, from whatever pi stored. An unnormalized
 * URL would build `https://api.https://acme.ghe.com/...`, which throws inside
 * `fetch` rather than returning a status.
 */
export function copilotDomain(raw: unknown): string {
	if (typeof raw !== "string" || raw.trim() === "") return "github.com";
	const trimmed = raw.trim();
	try {
		return (trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`)).hostname;
	} catch {
		return "github.com";
	}
}

/**
 * Copilot's quota lives on api.github.com and is read with the GitHub OAuth token
 * (`refresh` in pi's auth.json record), not the ~30-minute Copilot bearer pi hands
 * to models (`access`, which is what `getApiKeyForProvider` returns).
 */
export const copilotProbe: Probe = async (deps) => {
	const creds = deps.credentials();
	// `COPILOT_GITHUB_TOKEN` is pi's env-key path, which writes no auth.json record.
	const oauth = typeof creds?.refresh === "string" && creds.refresh !== "" ? creds.refresh : deps.env("COPILOT_GITHUB_TOKEN");
	if (!oauth) return null;
	const domain = copilotDomain(creds?.enterpriseUrl);
	try {
		const body = await json(deps, `https://api.${domain}/copilot_internal/user`, { Authorization: `Bearer ${oauth}`, ...COPILOT_HEADERS });
		return copilotAccount(body, Date.now());
	} catch (error) {
		// The GitHub OAuth token is the one pi cannot mint again on its own.
		if (isUnauthorized(error)) return LOGIN_EXPIRED;
		throw error;
	}
};

const DEEPSEEK_HOSTS = new Set(["api.deepseek.com", "api.deepseek.cn"]);

export const deepseekProbe: Probe = async (deps) => {
	// A `deepseek` entry repointed at a gateway carries that gateway's key, which is
	// not DeepSeek's to receive. `""` (an unparseable baseUrl) is refused too.
	const host = deps.baseUrl();
	if (host !== undefined && !DEEPSEEK_HOSTS.has(host)) return null;
	const key = await deps.apiKey();
	if (!key) return null;
	return deepseekAccount(await json(deps, "https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` }));
};

/**
 * `45m`, `3h`, `4d` — a reset at window scale. Floored so the figure holds still,
 * and `now` under a minute because `0m` reads as broken.
 */
export function untilShort(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How long until a rate-limit window turns over, from whichever field the account sent. */
function windowResetMs(window: any, now: number): number | undefined {
	const seconds = num(window?.reset_after_seconds) ?? num(window?.resets_in_seconds);
	if (seconds !== undefined) return seconds * 1000;
	const at = window?.resets_at ?? window?.reset_at;
	const epoch = num(at);
	// Seconds or milliseconds, told apart by magnitude.
	if (epoch !== undefined) return (epoch > 1e11 ? epoch : epoch * 1000) - now;
	if (typeof at === "string") {
		const parsed = Date.parse(at);
		if (Number.isFinite(parsed)) return parsed - now;
	}
	return undefined;
}

/**
 * How wide a rate-limit window is, as the name it goes by: `5h`, `7d`. Read from
 * the window because the plan decides it; the fallback is only for a payload that
 * omits the width.
 */
export function windowLabel(window: unknown, fallback: string): string {
	const w = window as any;
	const minutes = num(w?.window_minutes);
	const seconds = num(w?.limit_window_seconds) ?? (minutes !== undefined ? minutes * 60 : undefined);
	if (seconds === undefined || seconds <= 0) return fallback;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	const hours = Math.round(seconds / 3600);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * A ChatGPT plan's rate-limit windows, as a chip: both windows in wire order, each
 * named by its own width and carrying its own reset, coloured by the worse one.
 * Reported as what is left, though the wire says `used_percent`. Credits are
 * appended only once a window is spent; `∞` only for an account with no
 * `rate_limit` object at all.
 */
export function codexAccount(body: unknown, now: number): Account | null {
	const payload = body as any;
	const limits = payload?.rate_limit;
	const credits = payload?.credits;

	const parts: string[] = [];
	let worstLeft: number | undefined;
	for (const [key, fallback] of [
		["primary_window", "5h"],
		["secondary_window", "wk"],
	] as const) {
		const used = num(limits?.[key]?.used_percent);
		if (used === undefined) continue;
		// Clamped and rounded once, so the number displayed is the number coloured and
		// the number the credits line keys off.
		const left = Math.min(100, Math.max(0, Math.round(100 - used)));
		const reset = untilShort(windowResetMs(limits[key], now));
		parts.push(`${windowLabel(limits[key], fallback)} ${left}%${reset ? ` · ${reset}` : ""}`);
		if (worstLeft === undefined || left < worstLeft) worstLeft = left;
	}

	// Windows we failed to read are a blank margin, not an unlimited plan.
	if (worstLeft === undefined) return !limits && credits?.unlimited === true ? { label: "quota", value: "∞", tone: "info" } : null;

	let value = parts.join("  ");
	const balance = num(credits?.balance);
	if (worstLeft <= 0 && credits?.unlimited !== true && balance !== undefined && balance > 0) value += `  ${Math.round(balance)} credits`;

	// The account saying it has already refused a request outranks the percentage.
	const blocked =
		limits?.limit_reached === true ||
		limits?.allowed === false ||
		(typeof payload?.rate_limit_reached_type === "string" && payload.rate_limit_reached_type !== "");
	return { label: "quota", value, tone: blocked ? "error" : toneFor(worstLeft) };
}

/** The first instant of the current UTC month, in whole seconds — the Costs API's unit. */
export function monthStartSeconds(now: number): number {
	const at = new Date(now);
	return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) / 1000);
}

/**
 * `/v1/organization/costs` for the month so far, summed, as a chip. Spend, not a
 * balance, and uncoloured: an OpenAI account publishes no ceiling.
 */
export function openaiSpend(body: unknown): Account | null {
	const buckets = (body as any)?.data;
	if (!Array.isArray(buckets)) return null;
	// A page cut short would sum to a real-looking number that is simply too small.
	if ((body as any).has_more === true) return null;
	let total = 0;
	let currency = "USD";
	for (const bucket of buckets) {
		for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
			const amount = num(result?.amount?.value);
			if (amount === undefined) continue;
			total += amount;
			const unit = result?.amount?.currency;
			if (typeof unit === "string" && unit !== "") currency = unit;
		}
	}
	return { label: "spent", value: `${formatMoney(total, currency)} mtd`, tone: "info" };
}

const CODEX_HOST = "chatgpt.com";

export const codexProbe: Probe = async (deps) => {
	// An `openai-codex` entry repointed at a relay carries that relay's token.
	const host = deps.baseUrl();
	if (host !== undefined && host !== CODEX_HOST) return null;
	// pi's key for this provider *is* the OAuth access token, freshly refreshed.
	const token = await deps.apiKey();
	// Resolution may refresh or replace the record; read the account id afterwards.
	const creds = deps.credentials();
	if (!token) {
		if (creds?.type === "oauth") throw new Error("Account credential lookup returned no access token");
		return null;
	}
	const accountId = creds?.accountId;
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, originator: "pi", "User-Agent": "pi" };
	if (typeof accountId === "string" && accountId !== "") headers["chatgpt-account-id"] = accountId;
	// `/wham/usage`, not `/api/codex/usage`: on chatgpt.com only the former is routed.
	try {
		return codexAccount(await json(deps, `https://${CODEX_HOST}/backend-api/wham/usage`, headers), Date.now());
	} catch (error) {
		if (isUnauthorized(error)) return LOGIN_EXPIRED;
		throw error;
	}
};

const OPENAI_HOST = "api.openai.com";

export const openaiProbe: Probe = async (deps) => {
	const host = deps.baseUrl();
	if (host !== undefined && host !== OPENAI_HOST) return null;
	// The Costs API wants `api.management.read`, which only an Admin key carries. The
	// model's own key is never tried: it would 401 three times a session for the
	// life of the install. A project or service-account key is refused for the same
	// reason, without a request.
	const key = deps.env("OPENAI_ADMIN_KEY");
	if (!key || key.startsWith("sk-proj-") || key.startsWith("sk-svcacct-")) return null;
	// `limit=31`: the default page is 7 daily buckets and a month runs to 31.
	const url = `https://${OPENAI_HOST}/v1/organization/costs?start_time=${monthStartSeconds(Date.now())}&limit=31`;
	return openaiSpend(await json(deps, url, { Authorization: `Bearer ${key}` }));
};

/**
 * The providers that publish this, by pi's provider id. Deliberately no
 * `anthropic` entry: its usage report needs an admin key the session does not have.
 */
export const PROBES: Record<string, Probe> = {
	"github-copilot": copilotProbe,
	deepseek: deepseekProbe,
	"openai-codex": codexProbe,
	openai: openaiProbe,
};
