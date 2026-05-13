import { isAbsolute } from "node:path";
import type { ResolvedLauncherConfig } from "../config/launchers.js";
import type { RunExecution } from "../run/manifest.js";

export const BUILTIN_BACKEND_IDS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "passive",
] as const;
export type BuiltinBackendId = (typeof BUILTIN_BACKEND_IDS)[number];
export type BackendName = string;
export const RESERVED_BACKEND_NAMES: ReadonlySet<string> = new Set(BUILTIN_BACKEND_IDS);

export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CodexTransportConfig =
  | { type: "stdio" }
  | { type: "ws"; url: string }
  | { type: "uds"; path: string };

export interface BackendArgsEntry {
  extraArgs: string[];
}

export type BackendArgsConfig = Partial<Record<BackendName, BackendArgsEntry>>;
export type ResolvedBackendArgs = string[];

export function isWsOrWssUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ws:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

export function isAbsoluteUdsSocketPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && isAbsolute(trimmed);
}

export function cloneBackendConfig<T = unknown>(backendConfig: T | undefined): T | undefined {
  return backendConfig === undefined ? undefined : structuredClone(backendConfig);
}

export function isJsonishPersistable(value: unknown): boolean {
  return isJsonishPersistableValue(value, new Set<object>());
}

function isJsonishPersistableValue(value: unknown, stack: Set<object>): boolean {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return false;
    case "object":
      break;
  }

  if (stack.has(value)) {
    return false;
  }
  stack.add(value);

  if (Array.isArray(value)) {
    const valid = value.every((entry) => isJsonishPersistableValue(entry, stack));
    stack.delete(value);
    return valid;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    stack.delete(value);
    return false;
  }
  const valid = Object.values(value as Record<string, unknown>).every((entry) =>
    isJsonishPersistableValue(entry, stack),
  );
  stack.delete(value);
  return valid;
}

export function cloneBackendArgsConfig(
  backendArgs: BackendArgsConfig | undefined,
): BackendArgsConfig | undefined {
  if (!backendArgs) {
    return undefined;
  }
  const cloned: BackendArgsConfig = {};
  for (const [backendId, entry] of Object.entries(backendArgs)) {
    if (entry) {
      cloned[backendId] = {
        extraArgs: cloneResolvedBackendArgs(entry.extraArgs),
      };
    }
  }
  return cloned;
}

export function cloneResolvedBackendArgs(args: ResolvedBackendArgs): ResolvedBackendArgs {
  return [...args];
}

export type BackendEvent =
  | {
      type: "agent_message_delta";
      text: string;
    }
  | {
      type: "backend_notice";
      text: string;
    };

export interface BackendConfigResolutionContext {
  backendName: BackendName;
  authoredConfig: unknown;
  overrideConfig?: unknown;
  env: Record<string, string>;
  execution: RunExecution;
}

export interface BackendInvokeContext {
  prompt: string;
  cwd: string;
  processCwd?: string;
  env: Record<string, string>;
  model?: string;
  effort?: EffortLevel;
  backendConfig?: unknown;
  resolvedBackendArgs: ResolvedBackendArgs;
  launcher?: ResolvedLauncherConfig;
  unrestricted?: boolean;
  timeoutSec: number;
  resumeSessionId?: string;
  name?: string;
  abortSignal?: AbortSignal;
  detachSignal?: AbortSignal;
  emit?: (event: BackendEvent) => void;
  onRawStdoutLine?: (line: string) => void;
}

export interface BackendInvokeResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  sessionId: string | null;
  transcript: string | null;
  rawStdout: string;
  rawStderr: string;
  detached?: boolean;
}

export interface ValidateSessionContext {
  sessionId: string;
  cwd: string;
  processCwd?: string;
  env?: Record<string, string>;
  backendConfig?: unknown;
  resolvedBackendArgs: ResolvedBackendArgs;
  timeoutSec?: number;
}

export type ValidateSessionResult = { valid: true } | { valid: false; reason: string };

export interface BackendSessionHistorySourceContext {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  backendConfig?: unknown;
  resolvedBackendArgs: ResolvedBackendArgs;
  previousSource?: BackendSessionHistorySource | null;
}

export type BackendSessionHistorySourceResult =
  | { available: true; source: BackendSessionHistorySource }
  | { available: false; reason: string; transient?: boolean };

export type BackendSessionHistorySource =
  | {
      kind: "file";
      path: string;
      mtimeMs: number;
      size: number;
      changeToken: {
        kind: "file";
        path: string;
        mtimeMs: number;
        size: number;
      };
    }
  | {
      kind: "custom";
      label: string;
      changeToken: unknown;
    };

export interface BackendSessionHistoryContext {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  backendConfig?: unknown;
  resolvedBackendArgs: ResolvedBackendArgs;
  source: BackendSessionHistorySource;
  cursor?: unknown;
  mode: "bootstrap" | "sync";
}

export interface BackendSessionHistoryResult {
  source: BackendSessionHistorySource;
  cursor: unknown;
  turns: BackendSyncedTurn[];
}

export interface BackendSyncedTurn {
  backendTurnId: string;
  status: "complete" | "open";
  startedAt: string;
  updatedAt: string;
  userText: string | null;
  assistantText: string | null;
}

export interface BackendSyncedTurnMatchContext {
  prompt: string;
  turn: BackendSyncedTurn;
}

export interface BackendSyncedTurnTimingContext {
  attemptStartedAt: string;
  attemptEndedAt: string | null;
  turn: BackendSyncedTurn;
}

export interface BackendLauncherContext {
  backendConfig?: unknown;
}

export interface BackendRenameSessionContext {
  sessionId: string;
  cwd: string;
  processCwd?: string;
  env: Record<string, string>;
  backendConfig?: unknown;
  resolvedBackendArgs: ResolvedBackendArgs;
  name: string | null;
}

export interface Backend {
  id: BackendName;
  sourcePath?: string;
  launcherMode?: "applies" | "direct";
  launcherApplies?(ctx: BackendLauncherContext): boolean;
  resolveConfig?(ctx: BackendConfigResolutionContext): unknown | Promise<unknown>;
  invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult>;
  /**
   * Whether `--backend-session-id` bootstrap import is supported for
   * this backend. Omitted means "supported" to preserve the existing
   * behavior for backends that either validate explicitly or accept the
   * imported id as-is. Backends can set this to `false` when their
   * public resume ids are not safely self-validating.
   */
  supportsBootstrapSessionImport?: boolean;
  /**
   * Optional. Cheap, read-only check that the given backend session id
   * exists and is compatible with the supplied `cwd`. Used by the
   * `--backend-session-id` import flow at the top of `runAgent`,
   * before any workspace creation. Backends that can't cheaply
   * validate may omit this method; the runner treats omission as
   * "always valid" and lets the first real invocation discover the
   * truth.
   */
  validateSessionId?(ctx: ValidateSessionContext): Promise<ValidateSessionResult>;
  /**
   * Optional read-only discovery for backend-owned session history. Return
   * `available: false` when the backend cannot currently resolve durable
   * history for the supplied session id.
   */
  resolveSessionHistorySource?(
    ctx: BackendSessionHistorySourceContext,
  ): Promise<BackendSessionHistorySourceResult>;
  /**
   * Optional reader for complete/open turns from a previously resolved
   * backend-owned history source. Returned source change tokens and cursors
   * must be JSON-persistable because task-runner stores them in run.json.
   */
  readSessionHistory?(ctx: BackendSessionHistoryContext): Promise<BackendSessionHistoryResult>;
  /**
   * Optional backend-owned equivalence check used when sync tries to
   * identify a backend history turn that corresponds to an already-recorded
   * task-runner attempt. Use this for backend storage quirks; exact prompt
   * equality is always accepted before this hook is called.
   */
  taskRunnerPromptMatchesSyncedTurn?(ctx: BackendSyncedTurnMatchContext): boolean;
  /**
   * Optional backend-owned timing equivalence check used after sync has
   * matched a backend history turn by session and prompt. Omitted means the
   * task-runner attempt and backend turn timestamp windows must overlap.
   */
  taskRunnerAttemptTimingMatchesSyncedTurn?(ctx: BackendSyncedTurnTimingContext): boolean;
  /**
   * Optional backend-owned propagation for `run set-name` when the backend
   * can persist names on its own session/thread object.
   */
  renameSession?(ctx: BackendRenameSessionContext): Promise<void>;
}
