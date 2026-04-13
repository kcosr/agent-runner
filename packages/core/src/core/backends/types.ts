export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
}

export type ValidateSessionResult = { valid: true } | { valid: false; reason: string };

export interface Backend {
  id: string;
  invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult>;
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
