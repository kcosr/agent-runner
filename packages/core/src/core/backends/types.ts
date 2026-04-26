import { isAbsolute } from "node:path";
import type { ResolvedLauncherConfig } from "../config/launchers.js";

export const BACKEND_IDS = ["claude", "codex", "cursor", "pi", "passive"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CodexTransportConfig =
  | { type: "stdio" }
  | { type: "ws"; url: string }
  | { type: "uds"; path: string };

export interface CodexTransportEnvValues {
  udsPath?: string;
  wsUrl?: string;
}

export interface BackendSpecificConfig {
  codex?: {
    transport?: CodexTransportConfig;
  };
}

export interface BackendArgsEntry {
  extraArgs?: string[];
}

export type BackendArgsConfig = Partial<Record<BackendId, BackendArgsEntry>>;
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

export function codexTransportFromEnvValues(
  env: CodexTransportEnvValues,
): CodexTransportConfig | undefined {
  const udsPath = env.udsPath?.trim();
  const wsUrl = env.wsUrl?.trim();
  if (udsPath && wsUrl) {
    throw new Error("TASK_RUNNER_CODEX_UDS_PATH and TASK_RUNNER_CODEX_WS_URL cannot both be set");
  }
  if (udsPath) {
    if (!isAbsoluteUdsSocketPath(udsPath)) {
      throw new Error("TASK_RUNNER_CODEX_UDS_PATH must be an absolute socket path");
    }
    return {
      type: "uds",
      path: udsPath,
    };
  }
  if (!wsUrl) {
    return undefined;
  }
  if (!isWsOrWssUrl(wsUrl)) {
    throw new Error("TASK_RUNNER_CODEX_WS_URL must be an absolute ws:// or wss:// URL");
  }
  return {
    type: "ws",
    url: wsUrl,
  };
}

export function cloneBackendSpecificConfig(
  backendSpecific: BackendSpecificConfig | undefined,
): BackendSpecificConfig | undefined {
  if (!backendSpecific) {
    return undefined;
  }
  return {
    codex: backendSpecific.codex
      ? {
          transport: backendSpecific.codex.transport
            ? { ...backendSpecific.codex.transport }
            : undefined,
        }
      : undefined,
  };
}

export function cloneBackendArgsConfig(
  backendArgs: BackendArgsConfig | undefined,
): BackendArgsConfig | undefined {
  if (!backendArgs) {
    return undefined;
  }
  const cloned: BackendArgsConfig = {};
  for (const backendId of BACKEND_IDS) {
    const entry = backendArgs[backendId];
    if (entry) {
      cloned[backendId] = {
        extraArgs: entry.extraArgs ? [...entry.extraArgs] : undefined,
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

export interface BackendInvokeContext {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: EffortLevel;
  backendSpecific?: BackendSpecificConfig;
  resolvedBackendArgs: ResolvedBackendArgs;
  launcher?: ResolvedLauncherConfig;
  unrestricted?: boolean;
  timeoutSec: number;
  resumeSessionId?: string;
  name?: string;
  abortSignal?: AbortSignal;
  emit?: (event: BackendEvent) => void;
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
}

export interface ValidateSessionContext {
  sessionId: string;
  cwd: string;
  env?: Record<string, string>;
  backendSpecific?: BackendSpecificConfig;
  resolvedBackendArgs?: ResolvedBackendArgs;
}

export type ValidateSessionResult = { valid: true } | { valid: false; reason: string };

export interface Backend {
  id: BackendId;
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
}
