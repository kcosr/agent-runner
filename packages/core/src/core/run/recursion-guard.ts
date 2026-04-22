/**
 * Recursion depth guard.
 *
 * Prevents runaway agent-spawning-agent loops where one task-runner
 * invocation calls a backend that itself shells out to another
 * `task-runner run`. Without a guard, a misbehaving agent could spin
 * up an unbounded chain of backend processes.
 *
 * Mechanism: two env vars travel through every child invocation.
 *
 *   TASK_RUNNER_CALL_DEPTH       — current depth (0 at the outermost call)
 *   TASK_RUNNER_MAX_CALL_DEPTH   — hard cap, default 1
 *
 * On entry, `runAgent` reads the current depth from its own env. If
 * `currentDepth >= maxDepth` it throws `RecursionDepthError` before
 * creating the workspace or invoking any backend. When constructing
 * the env for the backend child process, the runner overlays an
 * incremented depth so a nested `task-runner run` inherits it.
 *
 * The default cap is 1 — i.e. only one level of nesting is allowed.
 * A user invocation (depth 0) can spawn one agent that itself runs
 * `task-runner run` (depth 1), but that nested invocation refuses to
 * spawn another. Two-level recursion has not yet shown up as a real
 * use case and almost every "agent calls agent calls agent" scenario
 * is a confused agent looping on itself, so the default is set tight
 * and explicit. Override with `TASK_RUNNER_MAX_CALL_DEPTH=N` if you
 * have a real reason for deeper chains.
 */

export const TASK_RUNNER_CALL_DEPTH_ENV = "TASK_RUNNER_CALL_DEPTH";
export const TASK_RUNNER_MAX_CALL_DEPTH_ENV = "TASK_RUNNER_MAX_CALL_DEPTH";
export const TASK_RUNNER_PARENT_RUN_ID_ENV = "TASK_RUNNER_PARENT_RUN_ID";
export const DEFAULT_MAX_CALL_DEPTH = 1;

export class RecursionDepthError extends Error {
  constructor(
    public readonly currentDepth: number,
    public readonly maxDepth: number,
  ) {
    super(
      `recursion depth ${currentDepth} would exceed max ${maxDepth}\n  this task-runner invocation is nested ${currentDepth} level(s) deep inside another\n  task-runner run, which is at or above the safety cap. Set\n  ${TASK_RUNNER_MAX_CALL_DEPTH_ENV}=N to raise the limit if this is intentional.`,
    );
    this.name = "RecursionDepthError";
  }
}

export interface RecursionState {
  currentDepth: number;
  maxDepth: number;
}

export function readParentRunIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[TASK_RUNNER_PARENT_RUN_ID_ENV]?.trim();
  return value ? value : null;
}

function parseNonNegInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/**
 * Read the current recursion state from the parent env. Invalid /
 * non-numeric values fall back to defaults silently — we don't want a
 * malformed env var to either crash the runner or, worse, disable the
 * cap.
 */
export function readRecursionState(env: NodeJS.ProcessEnv = process.env): RecursionState {
  return {
    currentDepth: parseNonNegInt(env[TASK_RUNNER_CALL_DEPTH_ENV], 0),
    maxDepth: parseNonNegInt(env[TASK_RUNNER_MAX_CALL_DEPTH_ENV], DEFAULT_MAX_CALL_DEPTH),
  };
}

/**
 * Throws `RecursionDepthError` if this invocation is at or above the
 * cap. The check is `>=` (not `>`) because we're about to invoke a
 * backend at `currentDepth`; the *child* would land at `currentDepth + 1`.
 * If currentDepth already equals maxDepth, even one more step is too
 * many.
 */
export function checkRecursionDepth(state: RecursionState): void {
  if (state.currentDepth >= state.maxDepth) {
    throw new RecursionDepthError(state.currentDepth, state.maxDepth);
  }
}

/**
 * Build the env-var overlay for the backend child process: increment
 * the depth and propagate the cap. Merge this onto the regular env
 * (e.g. `{ ...process.env, ...buildChildRecursionEnv(state) }`) when
 * constructing `BackendInvokeContext.env`.
 */
export function buildChildRecursionEnv(
  state: RecursionState,
  parentRunId?: string | null,
): Record<string, string> {
  const childEnv: Record<string, string> = {
    [TASK_RUNNER_CALL_DEPTH_ENV]: String(state.currentDepth + 1),
    [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: String(state.maxDepth),
  };
  if (parentRunId) {
    childEnv[TASK_RUNNER_PARENT_RUN_ID_ENV] = parentRunId;
  }
  return childEnv;
}
