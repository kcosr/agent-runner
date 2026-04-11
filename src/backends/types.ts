export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface BackendInvokeContext {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: EffortLevel;
  unrestricted?: boolean;
  timeoutSec: number;
  resumeSessionId?: string;
  onStdoutText?: (text: string) => void;
  onStderrText?: (text: string) => void;
}

export interface BackendInvokeResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  sessionId: string | null;
  transcript: string | null;
  rawStdout: string;
  rawStderr: string;
}

export interface Backend {
  id: string;
  invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult>;
}
