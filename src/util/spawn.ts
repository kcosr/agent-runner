import { type ChildProcess, spawn } from "node:child_process";

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutText: string;
  stderrText: string;
  timedOut: boolean;
  aborted: boolean;
}

const KILL_GRACE_MS = 5_000;

export function runProcess(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (opts.abortSignal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdoutText: "",
        stderrText: "",
        timedOut: false,
        aborted: true,
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err as Error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;

    const sigkillAfterGrace = () => {
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGINT");
      } catch {
        // ignore
      }
      sigkillAfterGrace();
    }, opts.timeoutMs);

    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGINT");
      } catch {
        // ignore
      }
      if (killTimer === null) sigkillAfterGrace();
    };

    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      opts.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      opts.onStderr?.(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        signal,
        stdoutText: Buffer.concat(stdoutChunks).toString("utf8"),
        stderrText: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        aborted,
      });
    });
  });
}
