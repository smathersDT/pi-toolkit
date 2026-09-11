/**
 * Resolve a role's `model` field to a concrete model. pi-free: the caller
 * passes the available list and a `find` so this can be unit tested.
 *
 *   "inherit"      the parent's current model
 *   "cheap"        the first `cheapModels` entry that is available, else the
 *                  cheapest available model (input + output price) that has
 *                  reasoning or tool support, else the parent's model
 *   "provider/id"  that model, or an error listing what is available
 *   "id"           a bare id, when exactly one available model has it
 */

export interface ModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	[key: string]: unknown;
}

export interface ResolveOptions {
	current: ModelLike | undefined;
	available: ModelLike[];
	cheapModels: string[];
	find?: (provider: string, id: string) => ModelLike | undefined;
}

export function modelKey(model: { provider?: string; id?: string } | undefined): string {
	return model ? `${model.provider ?? ""}/${model.id ?? ""}` : "none";
}

function supportsTools(model: ModelLike): boolean {
	// pi models have no explicit flag; honour one when present and assume support otherwise.
	const flag = model.tools ?? model.supportsTools ?? (model.compat as { supportsTools?: boolean } | undefined)?.supportsTools;
	return flag !== false;
}

function price(model: ModelLike): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

export function pickCheapModel(opts: ResolveOptions): ModelLike {
	for (const key of opts.cheapModels) {
		const hit = opts.available.find((m) => modelKey(m) === key);
		if (hit) return hit;
	}
	const candidates = opts.available.filter((m) => m.cost && (m.reasoning === true || supportsTools(m))).sort((a, b) => price(a) - price(b));
	if (candidates.length > 0) return candidates[0];
	if (opts.current) return opts.current;
	throw new Error("no model available for the child; configure cheapModels in subagents.json");
}

export function resolveModel(spec: string | undefined, opts: ResolveOptions): ModelLike {
	const s = (spec ?? "inherit").trim();
	if (s === "" || s === "inherit") {
		if (!opts.current) throw new Error("no model selected in the parent session");
		return opts.current;
	}
	if (s === "cheap") return pickCheapModel(opts);
	const slash = s.indexOf("/");
	if (slash > 0) {
		const provider = s.slice(0, slash);
		const id = s.slice(slash + 1);
		const found = opts.find?.(provider, id) ?? opts.available.find((m) => m.provider === provider && m.id === id);
		if (found) return found;
		throw new Error(`model "${s}" is not available. Available: ${listAvailable(opts.available)}`);
	}
	const byId = opts.available.filter((m) => m.id === s);
	if (byId.length === 1) return byId[0];
	if (byId.length > 1) throw new Error(`model id "${s}" is ambiguous: ${byId.map(modelKey).join(", ")}. Use provider/id.`);
	throw new Error(`model "${s}" is not available. Available: ${listAvailable(opts.available)}`);
}

function listAvailable(available: ModelLike[]): string {
	const keys = available.map(modelKey);
	return keys.length ? keys.slice(0, 40).join(", ") + (keys.length > 40 ? `, … (${keys.length - 40} more)` : "") : "none";
}
