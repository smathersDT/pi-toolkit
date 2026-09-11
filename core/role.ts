/**
 * Is this process the main pi session, or a child spawned by the subagent module?
 *
 * The subagent module sets these on every child it spawns:
 *   PI_TOOLKIT_ROLE   the role name ("researcher", "web", ...)
 *   PI_TOOLKIT_DEPTH  1 for a direct child, 2 for a grandchild
 *   PI_TOOLKIT_MAX_TURNS / PI_TOOLKIT_MAX_TOKENS  the caps the child enforces on itself
 */
export interface RuntimeRole {
	isChild: boolean;
	role: string | undefined;
	depth: number;
	maxTurns: number | undefined;
	maxTokens: number | undefined;
}

export function detectRole(env: NodeJS.ProcessEnv = process.env): RuntimeRole {
	const depth = Number.parseInt(env.PI_TOOLKIT_DEPTH ?? "0", 10) || 0;
	const role = env.PI_TOOLKIT_ROLE?.trim() || undefined;
	const maxTurns = Number.parseInt(env.PI_TOOLKIT_MAX_TURNS ?? "", 10) || undefined;
	const maxTokens = Number.parseInt(env.PI_TOOLKIT_MAX_TOKENS ?? "", 10) || undefined;
	return { isChild: depth > 0 || role !== undefined, role, depth, maxTurns, maxTokens };
}
