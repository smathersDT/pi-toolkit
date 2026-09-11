/**
 * The account poller: when to ask a provider what is left, and what to keep when it
 * will not say. pi-free: the clock, the probe table, the ctx lookup and the
 * credential reader all arrive through `PollerDeps`.
 *
 * The rules it enforces, each of which was a bug first:
 *
 *   - Nothing fetches until a footer is on screen (`attach`). A `--print` child fires
 *     `turn_end` like any other session and would otherwise bill a request per spawn.
 *   - A probe whose provider (or credential digest) changed mid-flight lands nowhere.
 *   - Only a refusal (401/404) counts toward giving up; a dropped connection retries.
 *   - Refreshes share an in-flight request, and the interval counts from its start.
 */
import type { Account, Probe, ProbeDeps } from "./account.ts";

export interface PollerDeps {
	/** The session pi last handed us; its `model` getter throws once pi invalidates it. */
	current(): SessionFacts | undefined;
	/** The probe table, by provider id. */
	probes: Record<string, Probe>;
	/** `fetch`, and the credential lookups a probe may need. */
	probeDeps(provider: string, facts: SessionFacts): ProbeDeps;
	now(): number;
	setInterval(fn: () => void, ms: number): { clear(): void };
}

/** The slice of pi's ctx the poller reads. */
export interface SessionFacts {
	provider: string | undefined;
	baseUrl: string | undefined;
	/** Changes after login, logout, token refresh, or account replacement. No raw secrets. */
	authVersion?: string;
}

/** How often the account is re-read on its own. */
export const ACCOUNT_REFRESH_MS = 5 * 60_000;

/** The floor for a refresh asked for out of turn (turn end, model switch). */
export const MIN_REFRESH_MS = 60_000;

/** Consecutive permanent failures (401/404) after which the probe gives up. */
export const MAX_FAILURES = 3;

/** Whether a probe failure will still be a failure in five minutes: 401 and 404 only. */
function isPermanent(message: string): boolean {
	// GitHub answers 403 for its rate limits, so the whole 4xx range is not a verdict.
	const status = Number(/^(\d{3}) /.exec(message)?.[1]);
	return status === 401 || status === 404;
}

/**
 * The account chip, kept fresh in the background. Owned by the module rather than
 * by a view, because pi builds a new view on every `session_start` and `/footer on`.
 */
export class AccountPoller {
	private identity: string | undefined;
	private generation = 0;
	private account: Account | null = null;
	private failures = 0;
	private fetchedAt = -Infinity;
	private inFlight: Promise<void> | undefined;
	private inFlightGeneration: number | undefined;
	private timer: { clear(): void } | undefined;
	private requestRender: (() => void) | undefined;
	private attached = false;

	/** Last probe failure, for `/footer account`; the footer itself stays blank. */
	error: string | undefined;

	private readonly deps: PollerDeps;

	constructor(deps: PollerDeps) {
		this.deps = deps;
	}

	/** The freshest known value. Never blocks, may be a few minutes old, may be null. */
	get(): Account | null {
		this.pump(false);
		return this.account;
	}

	/** What is cached, with no chance of starting a fetch. */
	peek(): Account | null {
		return this.account;
	}

	/**
	 * `/footer account`: fetch now, clearing the failure cap, and wait for the answer.
	 * The only caller allowed past the attach gate.
	 */
	refresh(): Promise<void> {
		if (!this.inFlight) this.invalidate();
		return this.pump(false, true);
	}

	/** The live view's redraw; also the signal that a footer is on screen. */
	attach(requestRender: () => void): void {
		this.requestRender = requestRender;
		this.attached = true;
		if (this.timer) return;
		this.timer = this.deps.setInterval(() => {
			try {
				this.pump(false);
			} catch {
				/* a stale ctx between sessions; the next tick has the new one */
			}
		}, ACCOUNT_REFRESH_MS);
	}

	/** Whether a footer is on screen to read this. False in `--print`, json and rpc. */
	get isAttached(): boolean {
		return this.attached;
	}

	/** Stop polling and forget the session (session_shutdown, `/footer off`). */
	dispose(): void {
		this.timer?.clear();
		this.timer = undefined;
		this.attached = false;
		this.requestRender = undefined;
		this.generation += 1;
		this.identity = undefined;
		this.account = null;
		this.error = undefined;
		this.invalidate();
	}

	/** Make the next `pump` fetch, whatever the clock and the failure count say. */
	invalidate(): void {
		this.failures = 0;
		this.fetchedAt = -Infinity;
	}

	/** Clear cached results whenever the account or endpoint behind the model changes. */
	private syncFacts(): SessionFacts | undefined {
		const facts = this.deps.current();
		const identity = JSON.stringify([facts?.provider, facts?.baseUrl, facts?.authVersion]);
		if (identity !== this.identity) {
			this.identity = identity;
			this.generation += 1;
			this.account = null;
			this.error = undefined;
			this.invalidate();
		}
		return facts;
	}

	/**
	 * Fetch if it is due; returns the in-flight probe so a caller can wait on it.
	 * `force` relaxes the interval to `MIN_REFRESH_MS`; only `invalidate()` overrules
	 * the failure cap.
	 */
	pump(force: boolean, evenIfDetached = false): Promise<void> {
		if (!this.attached && !evenIfDetached) return Promise.resolve();
		let facts: SessionFacts | undefined;
		try {
			facts = this.syncFacts();
		} catch {
			return Promise.resolve(); // A render can also see an invalidated context.
		}
		const provider = facts?.provider;

		const probe = provider ? this.deps.probes[provider] : undefined;
		if (!probe || !facts) return Promise.resolve();
		if (this.inFlight) {
			if (this.inFlightGeneration === this.generation) return this.inFlight;
			// A probe for the provider we switched away from: wait it out, then run ours.
			// `.catch` because nothing else waits on a render-driven pump.
			return this.inFlight.then(() => this.pump(force, evenIfDetached)).catch(() => {});
		}
		if (this.failures >= MAX_FAILURES) return Promise.resolve();
		if (this.deps.now() - this.fetchedAt < (force ? MIN_REFRESH_MS : ACCOUNT_REFRESH_MS)) return Promise.resolve();

		const startedAt = this.deps.now();
		this.fetchedAt = startedAt;
		const forProvider = provider as string;
		const generation = this.generation;
		const isCurrent = () => {
			this.syncFacts();
			return generation === this.generation;
		};
		let pending: Promise<Account | null>;
		try {
			pending = probe(this.deps.probeDeps(forProvider, facts));
		} catch (error) {
			pending = Promise.reject(error);
		}
		const run = pending
			.then((account) => {
				if (!isCurrent()) return;
				this.failures = 0;
				this.error = undefined;
				this.settle(account);
			})
			.catch((err: unknown) => {
				try {
					if (!isCurrent()) return;
				} catch {
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				this.error = message;
				if (isPermanent(message)) this.failures += 1;
				// The previous value stands. A dropped wifi is not news about the account.
			})
			.finally(() => {
				this.inFlight = undefined;
				this.inFlightGeneration = undefined;
				// Login can finish while a request is on the wire; fetch the current account.
				if (generation !== this.generation) return this.pump(force, evenIfDetached);
				// `fetchedAt` stays at the moment the request went out, so the idle
				// interval is five minutes and not five plus the probe's latency.
			});
		this.inFlight = run;
		this.inFlightGeneration = generation;
		return run;
	}

	/** Land a result and redraw only when it actually reads differently. */
	private settle(account: Account | null): void {
		const changed = JSON.stringify(account) !== JSON.stringify(this.account);
		this.account = account;
		if (changed) this.requestRender?.();
	}
}
