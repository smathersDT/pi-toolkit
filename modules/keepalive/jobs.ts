/**
 * Background jobs: tool calls that outlived the cache deadline and kept running.
 *
 * pi-free. The registry hands each outcome over exactly once (`take`), chains
 * the caller's abort signal in (escape cancels the job), and kills a job at the
 * hard cap. `raceDeadline` is the one-shot timer the wrapper and `wait` share.
 */

export type JobStatus = "running" | "done" | "error" | "cancelled" | "killed";

export interface Job<T = unknown> {
	/** `b-1`, `d-2`: the tool's initial and a session-wide counter. */
	id: string;
	tool: string;
	label: string;
	startedAt: number;
	endedAt: number | undefined;
	status: JobStatus;
	/** The work's value once status is "done". Cleared when taken. */
	result: T | undefined;
	/** The work's rejection, or an Error naming the cancel/kill reason. */
	error: unknown;
	/** Set once the outcome crossed to the model (inline, through wait, or as a follow-up). */
	delivered: boolean;
	/** Resolves (never rejects) when the job settles. */
	settled: Promise<Job<T>>;
	/** Aborts the work. */
	abort: AbortController;
}

export interface StartOptions<T> {
	tool: string;
	label: string;
	run: (signal: AbortSignal) => Promise<T>;
	/** The caller's signal; aborting it cancels the job. */
	signal?: AbortSignal;
	/** Kill the job after this many milliseconds. */
	hardCapMs?: number;
	/** Test seam. */
	now?: () => number;
}

export type TakeOutcome<T = unknown> =
	| { kind: "delivered"; job: Job<T>; value: T | undefined; error: unknown }
	| { kind: "running"; job: Job<T> }
	| { kind: "already"; job: Job<T> }
	| { kind: "unknown"; id: string };

type Settle<T> = (status: JobStatus, result: T | undefined, error: unknown) => void;

/** Returned by `raceDeadline` when the deadline won. */
export const DEADLINE: unique symbol = Symbol("deadline");

/** Resolve with the promise's value, or `DEADLINE` after `ms`. Rejections pass through. */
export function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof DEADLINE>((resolve) => {
		timer = setTimeout(() => resolve(DEADLINE), Math.max(0, ms));
		(timer as { unref?: () => void }).unref?.();
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export class JobRegistry {
	private jobs = new Map<string, Job<any>>();
	private settlers = new Map<string, Settle<any>>();
	private listeners = new Set<(job: Job<any>) => void>();
	private seq = 0;

	start<T>(opts: StartOptions<T>): Job<T> {
		const now = opts.now ?? Date.now;
		const prefix = (opts.tool.trim().charAt(0) || "j").toLowerCase();
		const id = `${prefix}-${++this.seq}`;
		const abort = new AbortController();
		let resolveSettled: (job: Job<T>) => void = () => {};
		const job: Job<T> = {
			id,
			tool: opts.tool,
			label: opts.label,
			startedAt: now(),
			endedAt: undefined,
			status: "running",
			result: undefined,
			error: undefined,
			delivered: false,
			settled: new Promise<Job<T>>((resolve) => {
				resolveSettled = resolve;
			}),
			abort,
		};
		this.jobs.set(id, job);

		const onAbort = () => this.cancel(id, "aborted");
		const capMinutes = opts.hardCapMs === undefined ? 0 : Math.round(opts.hardCapMs / 60_000);
		const timer = opts.hardCapMs === undefined ? undefined : setTimeout(() => this.cancel(id, `killed after ${capMinutes} minutes (hard cap)`, "killed"), opts.hardCapMs);
		(timer as { unref?: () => void } | undefined)?.unref?.();

		const settle: Settle<T> = (status, result, error) => {
			if (job.status !== "running") return;
			job.status = status;
			job.result = result;
			job.error = error;
			job.endedAt = now();
			opts.signal?.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
			resolveSettled(job);
			for (const listener of this.listeners) {
				try {
					listener(job);
				} catch {}
			}
		};
		this.settlers.set(id, settle);

		Promise.resolve()
			.then(() => opts.run(abort.signal))
			.then(
				(value) => settle("done", value, undefined),
				(error) => settle("error", undefined, error),
			);

		if (opts.signal?.aborted) this.cancel(id, "aborted");
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	all(): Job[] {
		return [...this.jobs.values()];
	}

	running(): Job[] {
		return this.all().filter((j) => j.status === "running");
	}

	/** Settled jobs whose outcome has not crossed yet. */
	pending(): Job[] {
		return this.all().filter((j) => j.status !== "running" && !j.delivered);
	}

	/** Hand the outcome over once. The value is released from the registry afterwards. */
	take<T = unknown>(id: string): TakeOutcome<T> {
		const job = this.jobs.get(id) as Job<T> | undefined;
		if (!job) return { kind: "unknown", id };
		if (job.status === "running") return { kind: "running", job };
		if (job.delivered) return { kind: "already", job };
		job.delivered = true;
		const outcome: TakeOutcome<T> = { kind: "delivered", job, value: job.result, error: job.error };
		job.result = undefined;
		this.settlers.delete(id);
		return outcome;
	}

	cancel(id: string, reason = "cancelled", status: JobStatus = "cancelled"): boolean {
		const job = this.jobs.get(id);
		if (!job || job.status !== "running") return false;
		this.settlers.get(id)?.(status, undefined, new Error(`${job.tool} job ${id} ${reason}`));
		try {
			job.abort.abort();
		} catch {}
		return true;
	}

	cancelAll(reason = "cancelled"): number {
		let n = 0;
		for (const job of this.running()) if (this.cancel(job.id, reason)) n++;
		return n;
	}

	onSettle(listener: (job: Job) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * A pending job at once, else the first running job to settle; `undefined`
	 * when nothing is running or pending.
	 */
	waitAny(): Promise<Job | undefined> {
		const pending = this.pending();
		if (pending.length > 0) return Promise.resolve(pending[0]);
		const running = this.running();
		if (running.length === 0) return Promise.resolve(undefined);
		return Promise.race(running.map((j) => j.settled));
	}
}
