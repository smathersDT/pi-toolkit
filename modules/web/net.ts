/**
 * Network helpers shared by search.ts and fetch.ts. No pi imports.
 *
 * Every request in this module takes an injectable `fetchImpl` so tests run
 * against fixtures, and every request is bounded by a timeout that is combined
 * with the caller's abort signal (the tool signal pi passes to `execute`).
 */

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Combine the caller's abort signal with a per-request timeout. */
export function withTimeout(signal: AbortSignal | undefined, ms: number, label = "request"): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
	const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** Sleep, unless the caller gives up first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
