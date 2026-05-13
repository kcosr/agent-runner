import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type {
  Backend,
  BackendConfigResolutionContext,
  BackendInvokeContext,
  BackendInvokeResult,
  BackendSessionHistoryContext,
  BackendSessionHistoryResult,
  BackendSessionHistorySourceContext,
  BackendSessionHistorySourceResult,
  BackendSyncedTurn,
  CodexTransportConfig,
  EffortLevel,
  ValidateSessionContext,
  ValidateSessionResult,
} from "../core/backends/types.js";
import { isAbsoluteUdsSocketPath, isWsOrWssUrl } from "../core/backends/types.js";
import {
  TASK_RUNNER_CALL_DEPTH_ENV,
  TASK_RUNNER_CWD_ENV,
  TASK_RUNNER_MAX_CALL_DEPTH_ENV,
  TASK_RUNNER_PARENT_RUN_ID_ENV,
  TASK_RUNNER_RUN_GROUP_ID_ENV,
  TASK_RUNNER_RUN_ID_ENV,
} from "../core/run/recursion-guard.js";
import { resolveTaskRunnerCommand } from "../task-runner-command.js";
import { buildSpawnCommand } from "../util/spawn.js";
import {
  composePersistedTranscript,
  createLineFeeder,
  isRecord,
  normalizeBackendModel,
  readJsonlRecordLines,
  realFileIsUnderRoot,
  sessionHistoryFileSource,
  silentTranscriptFallback,
  streamBoundarySeparator,
} from "./shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// Effort and model helpers
// ─────────────────────────────────────────────────────────────────────────────

function mapEffortToCodex(effort: EffortLevel): string | null {
  switch (effort) {
    case "off":
      return null;
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "xhigh";
  }
}

const normalizeCodexModel = normalizeBackendModel;

const TURN_INTERRUPT_GRACE_MS = 1_000;
const TURN_INTERRUPT_RETRY_MS = 5_000;
const TURN_INTERRUPT_CONFIRM_MS = 5_000;
const CODEX_SESSION_ROOT_PARTS = [".codex", "sessions"] as const;

/**
 * Decide whether the turn was interrupted by something *outside* this
 * runner (e.g. a user connected directly to the codex websocket and
 * cancelled the turn from another client). Both our own timeout path
 * and our own SIGINT/abort path cause codex to emit
 * `turn/completed { status: "interrupted" }` because we call
 * `turn/interrupt` ourselves — but in those cases the corresponding
 * flag (`timedOut` / `aborted`) is already set. So an interrupt with
 * neither flag set means somebody else pulled the plug, and the run
 * loop should treat it as a clean abort instead of retrying.
 */
export function isExternalInterrupt(
  turnStatus: string,
  ourTimedOut: boolean,
  ourAborted: boolean,
): boolean {
  return turnStatus === "interrupted" && !ourTimedOut && !ourAborted;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 types
// ─────────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return typeof (msg as JsonRpcResponse).id === "number";
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport abstraction
// ─────────────────────────────────────────────────────────────────────────────

interface Transport {
  send(line: string): void;
  onMessage(handler: (line: string) => void): void;
  onStderr(handler: (text: string) => void): void;
  onClose(handler: (code: number | null, reason: string) => void): void;
  close(): Promise<void>;
  descriptor: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdio transport — spawns `codex app-server --listen stdio://`
// ─────────────────────────────────────────────────────────────────────────────

export function buildCodexAppServerArgs(
  unrestricted: boolean,
  resolvedBackendArgs: string[],
): string[] {
  const args: string[] = [];
  if (unrestricted) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push("app-server");
  args.push(...resolvedBackendArgs);
  return args;
}

function openStdioTransport(
  processCwd: string,
  env: Record<string, string>,
  unrestricted: boolean,
  resolvedBackendArgs: string[],
  launcher: BackendInvokeContext["launcher"],
  onRawStdoutLine: BackendInvokeContext["onRawStdoutLine"],
): Transport {
  const binary = process.env.TASK_RUNNER_CODEX_BIN ?? "codex";
  const launched = buildSpawnCommand({
    command: binary,
    args: buildCodexAppServerArgs(unrestricted, resolvedBackendArgs),
    launcher,
  });
  const child: ChildProcess = spawn(launched.command, launched.args, {
    cwd: processCwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let messageHandler: ((line: string) => void) | null = null;
  let stderrHandler: ((text: string) => void) | null = null;
  let closeHandler: ((code: number | null, reason: string) => void) | null = null;
  let closed = false;
  const lineFeeder = createLineFeeder({
    onLine: (line) => {
      if (line.trim().length > 0 && messageHandler) {
        messageHandler(line);
      }
    },
    onRawSegment: onRawStdoutLine,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    lineFeeder.feed(chunk.toString("utf8"));
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrHandler?.(chunk.toString("utf8"));
  });

  child.on("close", (code, signal) => {
    if (closed) return;
    closed = true;
    lineFeeder.flush();
    closeHandler?.(code, signal ? `signal ${signal}` : "exit");
  });
  child.on("error", (err) => {
    if (closed) return;
    closed = true;
    lineFeeder.flush();
    closeHandler?.(null, `spawn error: ${err.message}`);
  });

  return {
    descriptor: `stdio:${launched.command}`,
    send(line: string) {
      if (closed || !child.stdin) return;
      child.stdin.write(`${line}\n`);
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onStderr(handler) {
      stderrHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    async close() {
      if (closed) return;
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      // Give it a moment to exit cleanly, then SIGINT, then SIGKILL.
      await new Promise<void>((resolve) => {
        const settled = () => {
          lineFeeder.flush();
          closed = true;
          resolve();
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          settled();
          return;
        }
        const sigintTimer = setTimeout(() => {
          try {
            child.kill("SIGINT");
          } catch {
            // ignore
          }
        }, 500);
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 5_500);
        child.once("close", () => {
          clearTimeout(sigintTimer);
          clearTimeout(killTimer);
          settled();
        });
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket transport
// ─────────────────────────────────────────────────────────────────────────────

function openWebSocketTransport(args: {
  descriptor: string;
  createWebSocket: () => WebSocket;
  reportErrorsToStderr: boolean;
}): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = args.createWebSocket();

    let messageHandler: ((line: string) => void) | null = null;
    let stderrHandler: ((text: string) => void) | null = null;
    let closeHandler: ((code: number | null, reason: string) => void) | null = null;
    let closed = false;
    let opened = false;

    const finishOpenFailure = (reason: string, err?: Error): void => {
      if (closed) return;
      closed = true;
      reject(err ?? new Error(reason));
    };

    const finishTransportClose = (code: number | null, reason: string): void => {
      if (closed) return;
      closed = true;
      closeHandler?.(code, reason);
    };

    ws.on("open", () => {
      opened = true;
      resolve({
        descriptor: args.descriptor,
        send(line: string) {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          ws.send(line);
        },
        onMessage(handler) {
          messageHandler = handler;
        },
        onStderr(handler) {
          stderrHandler = handler;
        },
        onClose(handler) {
          closeHandler = handler;
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      });
    });

    ws.on("message", (data) => {
      const line = data.toString("utf8");
      if (line.trim().length > 0) {
        messageHandler?.(line);
      }
    });
    ws.on("error", (err) => {
      if (args.reportErrorsToStderr) {
        stderrHandler?.(`ws error: ${err.message}\n`);
      }
      if (!opened) {
        finishOpenFailure(`ws error: ${err.message}`, err);
        return;
      }
      finishTransportClose(null, `ws error: ${err.message}`);
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
    ws.on("close", (code, reason) => {
      const closeReason = reason.toString("utf8") || "close";
      if (!opened) {
        finishOpenFailure(`websocket closed before open (${closeReason})`);
        return;
      }
      finishTransportClose(code, closeReason);
    });
  });
}

function openWsTransport(url: string): Promise<Transport> {
  return openWebSocketTransport({
    descriptor: `ws:${url}`,
    createWebSocket: () => new WebSocket(url),
    reportErrorsToStderr: true,
  });
}

function openUdsTransport(path: string): Promise<Transport> {
  return openWebSocketTransport({
    descriptor: `uds:${path}`,
    createWebSocket: () =>
      new WebSocket("ws://localhost/rpc", {
        createConnection: () => createConnection({ path }),
      }),
    // UDS connection failures already surface through the invoke catch path
    // with the original socket error; avoid duplicating them as stderr frames.
    reportErrorsToStderr: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC client
// ─────────────────────────────────────────────────────────────────────────────

type NotificationHandler = (method: string, params: unknown) => void;

interface CodexClient {
  call<T>(method: string, params: unknown): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  notify(handler: NotificationHandler): void;
  close(): Promise<void>;
  stderr: string;
  closeReason: string | null;
}

interface CreateClientOptions {
  onRawIncoming?: (line: string) => void;
  onRawOutgoing?: (line: string) => void;
}

async function closeCodexConnection(
  client?: Pick<CodexClient, "close">,
  transport?: Pick<Transport, "close">,
): Promise<void> {
  if (client) {
    await client.close().catch(() => {});
    return;
  }
  await transport?.close().catch(() => {});
}

function createClient(transport: Transport, opts: CreateClientOptions = {}): CodexClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  let notificationHandler: NotificationHandler | null = null;
  let stderrText = "";
  let closeReason: string | null = null;

  transport.onStderr((text) => {
    stderrText += text;
  });

  transport.onMessage((line) => {
    opts.onRawIncoming?.(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const error = new Error(
        `codex ${transport.descriptor} emitted malformed JSON-RPC: ${detail}`,
      );
      for (const [, entry] of pending) {
        entry.reject(error);
      }
      pending.clear();
      void transport.close().catch(() => {});
      return;
    }
    if (!isRecord(parsed)) return;
    const msg = parsed as unknown as JsonRpcMessage;
    if (isResponse(msg)) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      notificationHandler?.(msg.method, msg.params);
    }
  });

  transport.onClose((_code, reason) => {
    closeReason = reason;
    for (const [id, entry] of pending) {
      entry.reject(new Error(`transport closed (${reason}) before response to request ${id}`));
    }
    pending.clear();
  });

  return {
    async call<T>(method: string, params: unknown): Promise<T> {
      const id = nextId++;
      const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        try {
          const line = JSON.stringify(payload);
          opts.onRawOutgoing?.(line);
          transport.send(line);
        } catch (err) {
          pending.delete(id);
          reject(err as Error);
        }
      });
    },
    sendNotification(method, params) {
      const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (params !== undefined) payload.params = params;
      const line = JSON.stringify(payload);
      opts.onRawOutgoing?.(line);
      transport.send(line);
    },
    notify(handler) {
      notificationHandler = handler;
    },
    async close() {
      await transport.close();
    },
    get stderr() {
      return stderrText;
    },
    get closeReason() {
      return closeReason;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event accumulator — extracts transcript, session id, final status from the
// stream of notifications.
// ─────────────────────────────────────────────────────────────────────────────

interface AccumulatorState {
  threadId: string | null;
  turnId: string | null;
  turnIdWaiters: Array<(turnId: string) => void>;
  turnCompletionWaiters: Array<() => void>;
  streamedText: string;
  completedText: string;
  /**
   * The `item_id` of the most recently streamed agentMessage delta. Used
   * to detect message boundaries within a single turn — when the next
   * delta arrives with a different `item_id`, we insert a paragraph
   * break so the two messages don't get glued together.
   */
  lastStreamItemId: string | null;
  turnStatus: "in_progress" | "completed" | "failed" | "interrupted" | "unknown";
  turnError: string | null;
  turnCompleted: boolean;
  adoptFirstTurnStarted: boolean;
  onText: (text: string) => void;
  resolveCompleted: (() => void) | null;
}

function setTurnId(state: AccumulatorState, turnId: string): void {
  if (state.turnId) return;
  state.turnId = turnId;
  const waiters = state.turnIdWaiters.splice(0);
  for (const waiter of waiters) waiter(turnId);
}

function setTurnCompleted(state: AccumulatorState): void {
  if (state.turnCompleted) return;
  state.turnCompleted = true;
  const waiters = state.turnCompletionWaiters.splice(0);
  for (const waiter of waiters) waiter();
  state.resolveCompleted?.();
}

function notificationThreadId(params: Record<string, unknown>): string | null {
  return typeof params.threadId === "string" ? params.threadId : null;
}

function notificationTurnId(params: Record<string, unknown>): string | null {
  if (typeof params.turnId === "string") return params.turnId;
  const turn = params.turn;
  return isRecord(turn) && typeof turn.id === "string" ? turn.id : null;
}

function hasNotificationScope(params: Record<string, unknown>): boolean {
  return notificationThreadId(params) !== null || notificationTurnId(params) !== null;
}

function acceptCurrentTurnNotification(
  state: AccumulatorState,
  params: Record<string, unknown>,
): boolean {
  const threadId = notificationThreadId(params);
  if (state.threadId === null || threadId !== state.threadId) return false;

  const turnId = notificationTurnId(params);
  if (turnId === null) return false;
  return state.turnId !== null && turnId === state.turnId;
}

export function waitForTurnId(state: AccumulatorState, timeoutMs: number): Promise<string | null> {
  if (state.turnId) return Promise.resolve(state.turnId);
  return new Promise((resolve) => {
    const onTurnId = (turnId: string) => {
      clearTimeout(timeoutHandle);
      resolve(turnId);
    };
    const timeoutHandle = setTimeout(() => {
      const idx = state.turnIdWaiters.indexOf(onTurnId);
      if (idx >= 0) state.turnIdWaiters.splice(idx, 1);
      resolve(state.turnId);
    }, timeoutMs);
    state.turnIdWaiters.push(onTurnId);
  });
}

export function waitForTurnCompletion(
  state: AccumulatorState,
  timeoutMs: number,
): Promise<boolean> {
  if (state.turnCompleted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onCompleted = () => {
      clearTimeout(timeoutHandle);
      resolve(true);
    };
    const timeoutHandle = setTimeout(() => {
      const idx = state.turnCompletionWaiters.indexOf(onCompleted);
      if (idx >= 0) state.turnCompletionWaiters.splice(idx, 1);
      resolve(state.turnCompleted);
    }, timeoutMs);
    state.turnCompletionWaiters.push(onCompleted);
  });
}

type InterruptAttemptFailureReason = "missing_turn_id" | "rpc_error";

interface InterruptAttemptResult {
  requested: boolean;
  reason?: InterruptAttemptFailureReason;
  errorMessage?: string;
}

async function requestTurnInterrupt(
  client: Pick<CodexClient, "call">,
  state: AccumulatorState,
  retryWindowsMs: number[],
): Promise<InterruptAttemptResult> {
  for (const timeoutMs of retryWindowsMs) {
    const turnId = await waitForTurnId(state, timeoutMs);
    if (!state.threadId || !turnId) {
      continue;
    }
    try {
      await client.call("turn/interrupt", {
        threadId: state.threadId,
        turnId,
      });
      return { requested: true };
    } catch (err) {
      return {
        requested: false,
        reason: "rpc_error",
        errorMessage: (err as Error).message,
      };
    }
  }
  return {
    requested: false,
    reason: "missing_turn_id",
  };
}

export async function interruptTurnWithGrace(
  client: Pick<CodexClient, "call">,
  state: AccumulatorState,
  timeoutMs = TURN_INTERRUPT_GRACE_MS,
): Promise<boolean> {
  return (await requestTurnInterrupt(client, state, [timeoutMs])).requested;
}

export async function interruptTurnWithRetry(
  client: Pick<CodexClient, "call">,
  state: AccumulatorState,
  retryWindowsMs = [TURN_INTERRUPT_GRACE_MS, TURN_INTERRUPT_RETRY_MS],
): Promise<boolean> {
  return (await requestTurnInterrupt(client, state, retryWindowsMs)).requested;
}

type InterruptConfirmationResult =
  | {
      confirmed: true;
    }
  | {
      confirmed: false;
      reason: "missing_turn_id" | "rpc_error" | "timeout" | "wrong_terminal_status";
      errorMessage?: string;
      turnStatus?: AccumulatorState["turnStatus"];
    };

export async function confirmInterrupt(
  client: Pick<CodexClient, "call">,
  state: AccumulatorState,
  retryWindowsMs = [TURN_INTERRUPT_GRACE_MS, TURN_INTERRUPT_RETRY_MS],
  confirmMs = TURN_INTERRUPT_CONFIRM_MS,
): Promise<InterruptConfirmationResult> {
  const interrupt = await requestTurnInterrupt(client, state, retryWindowsMs);
  if (!interrupt.requested) {
    return {
      confirmed: false,
      reason: interrupt.reason ?? "rpc_error",
      errorMessage: interrupt.errorMessage,
    };
  }

  if (!(await waitForTurnCompletion(state, confirmMs))) {
    return {
      confirmed: false,
      reason: "timeout",
    };
  }

  if (state.turnStatus === "interrupted") {
    return { confirmed: true };
  }

  return {
    confirmed: false,
    reason: "wrong_terminal_status",
    turnStatus: state.turnStatus,
  };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let combined = "";
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string") {
      combined += item.text;
    }
  }
  return combined;
}

function handleNotification(state: AccumulatorState, method: string, params: unknown): void {
  if (!isRecord(params)) return;

  switch (method) {
    case "thread/started": {
      const thread = params.thread;
      if (state.threadId === null && isRecord(thread) && typeof thread.id === "string") {
        state.threadId = thread.id;
      }
      return;
    }
    case "turn/started": {
      if (state.adoptFirstTurnStarted) {
        const threadId = notificationThreadId(params);
        const turnId = notificationTurnId(params);
        if (state.threadId !== null && threadId === state.threadId && turnId !== null) {
          setTurnId(state, turnId);
        }
      }
      if (!acceptCurrentTurnNotification(state, params)) return;
      return;
    }
    case "item/agentMessage/delta": {
      if (!acceptCurrentTurnNotification(state, params)) return;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta.length === 0) return;
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      // Insert a paragraph break when the model emits a fresh
      // agentMessage in the same turn (e.g. before/after a tool call).
      // Without this, the tail of message N and the head of message N+1
      // get glued: "...sentence one.Sentence two...".
      if (itemId !== null && state.lastStreamItemId !== null && itemId !== state.lastStreamItemId) {
        const sep = streamBoundarySeparator(state.streamedText, delta);
        if (sep.length > 0) {
          state.streamedText += sep;
          state.onText(sep);
        }
      }
      state.streamedText += delta;
      state.onText(delta);
      if (itemId !== null) state.lastStreamItemId = itemId;
      return;
    }
    case "item/completed": {
      if (!acceptCurrentTurnNotification(state, params)) return;
      const item = params.item;
      if (isRecord(item)) {
        const type = typeof item.type === "string" ? item.type : "";
        if (type === "agentMessage" || type === "agent_message") {
          if (typeof item.text === "string" && item.text.length > 0) {
            state.completedText = item.text;
          } else {
            const text = extractTextFromContent(item.content);
            if (text.length > 0) state.completedText = text;
          }
        }
      }
      return;
    }
    case "turn/completed": {
      if (!acceptCurrentTurnNotification(state, params)) return;
      const turn = params.turn;
      if (isRecord(turn)) {
        const status = typeof turn.status === "string" ? turn.status : "unknown";
        if (status === "completed" || status === "failed" || status === "interrupted") {
          state.turnStatus = status;
        }
        const errorObj = turn.error;
        if (isRecord(errorObj) && typeof errorObj.message === "string") {
          state.turnError = errorObj.message;
        }
      }
      setTurnCompleted(state);
      return;
    }
    case "error": {
      if (hasNotificationScope(params) && !acceptCurrentTurnNotification(state, params)) return;
      // Intermediate error notification — record but don't treat as terminal
      // unless followed by turn/completed with status=failed.
      if (typeof params.message === "string" && state.turnError === null) {
        state.turnError = params.message;
      }
      const errorObj = params.error;
      if (isRecord(errorObj) && typeof errorObj.message === "string" && state.turnError === null) {
        state.turnError = errorObj.message;
      }
      return;
    }
    default:
      // Silent for everything else (reasoning deltas, command execution, etc.)
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex Backend
// ─────────────────────────────────────────────────────────────────────────────

const CODEX_AUTH_FAILURE_MARKERS = [
  "unauthorized",
  "forbidden",
  "authentication failed",
  "invalid api key",
  "api key is invalid",
  "not logged in",
  "login required",
  "permission denied",
  "access denied",
  "token expired",
] as const;

function cloneCodexTransportConfig(transport: CodexTransportConfig): CodexTransportConfig {
  switch (transport.type) {
    case "stdio":
      return { type: "stdio" };
    case "ws":
      return { type: "ws", url: transport.url };
    case "uds":
      return { type: "uds", path: transport.path };
  }
}

export interface CodexBackendConfig {
  transport: CodexTransportConfig;
}

export type CodexThreadStatus = "Active" | "Idle" | "SystemError" | "NotLoaded";

export interface CodexThreadReadResult {
  threadId: string;
  status: CodexThreadStatus;
  cwd: string | null;
}

export function normalizeCodexWsUrl(url: string): string {
  if (!isWsOrWssUrl(url)) {
    throw new Error(
      `codex websocket transport requires an absolute ws:// or wss:// URL, received "${url}"`,
    );
  }
  return new URL(url).toString();
}

export function normalizeCodexUdsPath(path: string): string {
  const trimmed = path.trim();
  if (!isAbsoluteUdsSocketPath(trimmed)) {
    throw new Error(`codex UDS transport requires an absolute socket path, received "${path}"`);
  }
  return trimmed;
}

function normalizeCodexTransportConfig(transport: CodexTransportConfig): CodexTransportConfig {
  if (transport.type === "ws") {
    return {
      type: "ws",
      url: normalizeCodexWsUrl(transport.url),
    };
  }
  if (transport.type === "uds") {
    return {
      type: "uds",
      path: normalizeCodexUdsPath(transport.path),
    };
  }
  return cloneCodexTransportConfig(transport);
}

function parseCodexTransport(value: unknown, sourceLabel: string): CodexTransportConfig {
  if (!isRecord(value)) {
    throw new Error(`${sourceLabel}.transport must be an object`);
  }
  if (value.type === "stdio") {
    const keys = Object.keys(value);
    if (keys.length !== 1) {
      throw new Error(`${sourceLabel}.transport stdio config only accepts type`);
    }
    return { type: "stdio" };
  }
  if (value.type === "ws") {
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "type" && key !== "url")) {
      throw new Error(`${sourceLabel}.transport ws config only accepts type and url`);
    }
    if (typeof value.url !== "string" || value.url.trim().length === 0) {
      throw new Error(`${sourceLabel}.transport.url must be a non-empty string`);
    }
    return {
      type: "ws",
      url: normalizeCodexWsUrl(value.url),
    };
  }
  if (value.type === "uds") {
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "type" && key !== "path")) {
      throw new Error(`${sourceLabel}.transport uds config only accepts type and path`);
    }
    if (typeof value.path !== "string" || value.path.trim().length === 0) {
      throw new Error(`${sourceLabel}.transport.path must be a non-empty string`);
    }
    return {
      type: "uds",
      path: normalizeCodexUdsPath(value.path),
    };
  }
  throw new Error(`${sourceLabel}.transport.type must be "stdio", "ws", or "uds"`);
}

function parseCodexBackendConfig(
  value: unknown,
  sourceLabel: string,
  requireTransport: boolean,
): CodexBackendConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${sourceLabel} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "transport")) {
    throw new Error(`${sourceLabel} only accepts transport`);
  }
  if (value.transport === undefined) {
    if (requireTransport) {
      throw new Error(`${sourceLabel}.transport is required`);
    }
    return undefined;
  }
  return {
    transport: parseCodexTransport(value.transport, sourceLabel),
  };
}

function codexTransportFromEnv(env: Record<string, string>): CodexTransportConfig | undefined {
  const udsPath = env.TASK_RUNNER_CODEX_UDS_PATH?.trim();
  const wsUrl = env.TASK_RUNNER_CODEX_WS_URL?.trim();
  if (udsPath && wsUrl) {
    throw new Error("TASK_RUNNER_CODEX_UDS_PATH and TASK_RUNNER_CODEX_WS_URL cannot both be set");
  }
  if (udsPath) {
    return {
      type: "uds",
      path: normalizeCodexUdsPath(udsPath),
    };
  }
  if (!wsUrl) {
    return undefined;
  }
  return {
    type: "ws",
    url: normalizeCodexWsUrl(wsUrl),
  };
}

export function resolveCodexBackendConfig(ctx: BackendConfigResolutionContext): CodexBackendConfig {
  const authored = parseCodexBackendConfig(
    ctx.authoredConfig,
    `backendConfig.${ctx.backendName}`,
    false,
  );
  if (authored) {
    return authored;
  }

  const override = parseCodexBackendConfig(
    ctx.overrideConfig,
    `overrides.backendConfig.${ctx.backendName}`,
    false,
  );
  if (override) {
    return override;
  }

  const envTransport = codexTransportFromEnv(ctx.env);
  return {
    transport: envTransport ?? { type: "stdio" },
  };
}

export function resolveCodexTransportConfig(ctx: {
  backendConfig?: unknown;
}): CodexTransportConfig {
  const config = parseCodexBackendConfig(ctx.backendConfig, "backendConfig.codex", true);
  if (!config) {
    throw new Error("codex backend requires backendConfig.codex.transport before invocation");
  }
  return normalizeCodexTransportConfig(config.transport);
}

async function openTransport(ctx: BackendInvokeContext): Promise<Transport> {
  const transport = resolveCodexTransportConfig(ctx);
  if (transport.type === "ws") {
    return openWsTransport(transport.url);
  }
  if (transport.type === "uds") {
    return openUdsTransport(transport.path);
  }
  return openStdioTransport(
    ctx.processCwd ?? ctx.cwd,
    ctx.env,
    ctx.unrestricted ?? false,
    ctx.resolvedBackendArgs,
    ctx.launcher,
    ctx.onRawStdoutLine,
  );
}

async function openInitializedCodexClient(ctx: BackendInvokeContext): Promise<{
  transport: Transport;
  client: CodexClient;
}> {
  const transport = await openTransport(ctx);
  const client = createClient(transport);
  await client.call("initialize", {
    clientInfo: {
      name: "task-runner",
      title: "task-runner",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  client.sendNotification("initialized");
  return { transport, client };
}

function parseCodexThreadStatus(value: unknown): CodexThreadStatus | null {
  if (value === "Active" || value === "Idle" || value === "SystemError" || value === "NotLoaded") {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return null;
  }
  return parseCodexThreadStatus(keys[0]);
}

export class CodexThreadReadProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexThreadReadProtocolError";
  }
}

function parseCodexThreadReadResult(sessionId: string, result: unknown): CodexThreadReadResult {
  if (!isRecord(result) || !isRecord(result.thread)) {
    throw new CodexThreadReadProtocolError(
      `codex thread/read for "${sessionId}" returned an unexpected response shape`,
    );
  }
  const thread = result.thread;
  const threadId = typeof thread.id === "string" ? thread.id : sessionId;
  const status = parseCodexThreadStatus(thread.status);
  if (status === null) {
    throw new CodexThreadReadProtocolError(
      `codex thread/read for "${sessionId}" returned an unknown thread status`,
    );
  }
  return {
    threadId,
    status,
    cwd: typeof thread.cwd === "string" ? thread.cwd : null,
  };
}

function backendInvokeContextFromSessionValidation(
  ctx: ValidateSessionContext,
): BackendInvokeContext {
  return {
    prompt: "",
    cwd: ctx.cwd,
    processCwd: ctx.processCwd,
    env: ctx.env ?? (process.env as Record<string, string>),
    backendConfig: ctx.backendConfig,
    resolvedBackendArgs: ctx.resolvedBackendArgs,
    timeoutSec: ctx.timeoutSec ?? 60,
  };
}

export async function readCodexThread(ctx: ValidateSessionContext): Promise<CodexThreadReadResult> {
  let transport: Transport | undefined;
  let client: CodexClient | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutMs = (ctx.timeoutSec ?? 60) * 1000;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void closeCodexConnection(client, transport);
      reject(new Error(`codex thread/read for "${ctx.sessionId}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const connection = await Promise.race([
      openInitializedCodexClient(backendInvokeContextFromSessionValidation(ctx)),
      timeout,
    ]);
    transport = connection.transport;
    client = connection.client;
    const result = await Promise.race([
      client.call<unknown>("thread/read", {
        threadId: ctx.sessionId,
      }),
      timeout,
    ]);
    return parseCodexThreadReadResult(ctx.sessionId, result);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    await closeCodexConnection(client, transport);
  }
}

function makeAccumulatorState(
  ctx: BackendInvokeContext,
  options: { adoptFirstTurnStarted?: boolean } = {},
): AccumulatorState {
  return {
    threadId: null,
    turnId: null,
    turnIdWaiters: [],
    turnCompletionWaiters: [],
    streamedText: "",
    completedText: "",
    lastStreamItemId: null,
    turnStatus: "in_progress",
    turnError: null,
    turnCompleted: false,
    adoptFirstTurnStarted: options.adoptFirstTurnStarted ?? false,
    onText: (text) => ctx.emit?.({ type: "agent_message_delta", text }),
    resolveCompleted: null,
  };
}

function waitForSignal(
  signal: AbortSignal | undefined,
  result: "abort" | "detach",
): Promise<"abort" | "detach"> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve(result);
      return;
    }
    signal.addEventListener("abort", () => resolve(result), { once: true });
  });
}

function recoveryControlResult(
  outcome: "abort" | "detach",
  state: AccumulatorState,
  rawStdoutChunks: string[],
  rawStderr: string,
): BackendInvokeResult {
  return {
    exitCode: outcome === "abort" ? 1 : null,
    signal: null,
    timedOut: false,
    aborted: outcome === "abort",
    detached: outcome === "detach" ? true : undefined,
    sessionId: state.threadId,
    transcript: null,
    rawStdout: rawStdoutChunks.join("\n"),
    rawStderr,
  };
}

async function raceWithRecoveryControl<T>(
  operation: Promise<T>,
  ctx: BackendInvokeContext,
): Promise<{ outcome: "value"; value: T } | { outcome: "abort" | "detach" }> {
  return await Promise.race([
    operation.then((value) => ({ outcome: "value" as const, value })),
    waitForSignal(ctx.abortSignal, "abort").then((outcome) => ({ outcome })),
    waitForSignal(ctx.detachSignal, "detach").then((outcome) => ({ outcome })),
  ]);
}

export async function adoptCodexActiveThread(
  ctx: BackendInvokeContext & { resumeSessionId: string },
): Promise<BackendInvokeResult> {
  const rawStdoutChunks: string[] = [];
  let transport: Transport | undefined;
  let client: CodexClient | undefined;
  let diagnostics = "";
  let aborted = false;
  let timedOut = false;
  const state = makeAccumulatorState(ctx, { adoptFirstTurnStarted: true });

  const emitBackendNotice = (text: string): void => {
    diagnostics += text;
    ctx.emit?.({ type: "backend_notice", text });
  };

  try {
    state.threadId = ctx.resumeSessionId;
    transport = await openTransport(ctx);
    transport.onStderr((text) => {
      ctx.emit?.({ type: "backend_notice", text });
    });
    client = createClient(transport, {
      onRawIncoming: (line) => rawStdoutChunks.push(`> ${line}`),
      onRawOutgoing: (line) => rawStdoutChunks.push(`< ${line}`),
    });
    client.notify((method, params) => handleNotification(state, method, params));
    await client.call("initialize", {
      clientInfo: {
        name: "task-runner",
        title: "task-runner",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.sendNotification("initialized");

    const resume = await raceWithRecoveryControl(
      client.call<unknown>(
        "thread/resume",
        buildCodexThreadParams(ctx, { threadId: ctx.resumeSessionId }),
      ),
      ctx,
    );
    if (resume.outcome !== "value") {
      return recoveryControlResult(
        resume.outcome,
        state,
        rawStdoutChunks,
        `${client.stderr}${diagnostics}`,
      );
    }
    const result = resume.value;
    if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") {
      state.threadId = result.thread.id;
    }

    const turnCompletedPromise = new Promise<void>((resolve) => {
      state.resolveCompleted = resolve;
      if (state.turnCompleted) {
        resolve();
      }
    });
    const turnTimeoutMs = ctx.timeoutSec * 1000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const turnDeadline = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), turnTimeoutMs);
    });
    const race = await Promise.race([
      turnCompletedPromise.then(() => "done" as const),
      turnDeadline,
      waitForSignal(ctx.abortSignal, "abort"),
      waitForSignal(ctx.detachSignal, "detach"),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (race === "detach") {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        detached: true,
        sessionId: state.threadId,
        transcript: null,
        rawStdout: rawStdoutChunks.join("\n"),
        rawStderr: `${client.stderr}${diagnostics}`,
      };
    }

    if (race === "timeout") {
      timedOut = true;
      await interruptTurnWithRetry(client, state);
    }

    if (race === "abort") {
      const interrupt = await confirmInterrupt(client, state);
      if (interrupt.confirmed) {
        aborted = true;
      } else {
        emitBackendNotice("codex: startup-recovered turn interrupt was not confirmed.\n");
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    emitBackendNotice(`${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted,
      sessionId: state.threadId ?? ctx.resumeSessionId,
      transcript: null,
      rawStdout: rawStdoutChunks.join("\n"),
      rawStderr: `${client?.stderr ?? ""}${diagnostics}`,
    };
  } finally {
    await client?.close().catch(() => {});
  }

  const transcript = composePersistedTranscript(state.streamedText, state.completedText);
  const fallbackDelta = silentTranscriptFallback(state.streamedText, transcript);
  if (fallbackDelta) {
    ctx.emit?.({ type: "agent_message_delta", text: fallbackDelta });
  }
  const exitCode = aborted ? 1 : !timedOut && state.turnStatus === "completed" ? 0 : 1;
  return {
    exitCode,
    signal: null,
    timedOut,
    aborted,
    sessionId: state.threadId ?? ctx.resumeSessionId,
    transcript,
    rawStdout: rawStdoutChunks.join("\n"),
    rawStderr: `${client?.stderr ?? ""}${diagnostics}`,
  };
}

const CODEX_LINEAGE_ENV_CONFIG_KEYS = [
  TASK_RUNNER_CALL_DEPTH_ENV,
  TASK_RUNNER_MAX_CALL_DEPTH_ENV,
  TASK_RUNNER_PARENT_RUN_ID_ENV,
  TASK_RUNNER_RUN_GROUP_ID_ENV,
  TASK_RUNNER_RUN_ID_ENV,
  TASK_RUNNER_CWD_ENV,
] as const;

function buildCodexLineageConfigOverrides(env: Record<string, string>): Record<string, string> {
  const config: Record<string, string> = {};
  for (const key of CODEX_LINEAGE_ENV_CONFIG_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      config[`shell_environment_policy.set.${key}`] = value;
    }
  }
  return config;
}

export function buildCodexThreadParams(
  ctx: BackendInvokeContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const extraConfig = isRecord(extra.config) ? extra.config : {};
  const lineageConfig = buildCodexLineageConfigOverrides(ctx.env);
  const config = {
    ...extraConfig,
    ...lineageConfig,
  };
  const params: Record<string, unknown> = {
    cwd: ctx.cwd,
    ...extra,
  };
  if (Object.keys(config).length > 0) {
    params.config = config;
  }
  if (ctx.model) {
    params.model = normalizeCodexModel(ctx.model);
  }
  if (ctx.effort) {
    const mapped = mapEffortToCodex(ctx.effort);
    if (mapped !== null) {
      params.effort = mapped;
    }
  }
  if (ctx.unrestricted) {
    params.approvalPolicy = "never";
    params.sandbox = "danger-full-access";
  }
  return params;
}

export function buildCodexTurnStartPayload(
  threadId: string,
  prompt: string,
  unrestricted: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    threadId,
    input: [{ type: "text", text: prompt }],
  };
  if (unrestricted) {
    payload.approvalPolicy = "never";
    payload.sandboxPolicy = { type: "dangerFullAccess" };
  }
  return payload;
}

function codexSessionsRoot(): string {
  return join(homedir(), ...CODEX_SESSION_ROOT_PARTS);
}

function codexMessageText(record: Record<string, unknown>, role: "assistant"): string | null {
  if (record.type !== "response_item" || !isRecord(record.payload)) {
    return null;
  }
  const payload = record.payload;
  if (payload.type !== "message" || payload.role !== role) {
    return null;
  }
  const text = extractTextFromContent(payload.content);
  return text.length > 0 ? text : null;
}

function codexUserMessageEventText(record: Record<string, unknown>): string | null {
  if (record.type !== "event_msg" || !isRecord(record.payload)) {
    return null;
  }
  const payload = record.payload;
  if (payload.type !== "user_message" || typeof payload.message !== "string") {
    return null;
  }
  return payload.message.length > 0 ? payload.message : null;
}

interface CodexTurnBuilder {
  backendTurnId: string;
  startedAt: string;
  updatedAt: string;
  userText: string | null;
  assistantText: string;
}

function joinCodexAssistantText(prior: string, next: string): string {
  return `${prior}${streamBoundarySeparator(prior, next)}${next}`;
}

export async function parseCodexSessionHistoryJsonl(path: string): Promise<BackendSyncedTurn[]> {
  const turns: BackendSyncedTurn[] = [];
  let current: CodexTurnBuilder | null = null;

  for (const { record } of await readJsonlRecordLines(path, "Codex")) {
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;

    if (record.type === "event_msg" && isRecord(record.payload)) {
      const payload = record.payload;
      const backendTurnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      if (payload.type === "task_started" && backendTurnId !== null && timestamp !== null) {
        current = {
          backendTurnId,
          startedAt: timestamp,
          updatedAt: timestamp,
          userText: null,
          assistantText: "",
        };
        continue;
      }
      if (
        payload.type === "task_complete" &&
        backendTurnId !== null &&
        timestamp !== null &&
        current?.backendTurnId === backendTurnId
      ) {
        current.updatedAt = timestamp;
        turns.push({
          backendTurnId: current.backendTurnId,
          status: "complete",
          startedAt: current.startedAt,
          updatedAt: current.updatedAt,
          userText: current.userText,
          assistantText: current.assistantText.length > 0 ? current.assistantText : null,
        });
        current = null;
        continue;
      }
    }

    if (current !== null && timestamp !== null) {
      const userText = codexUserMessageEventText(record);
      if (userText !== null) {
        current.userText =
          current.userText === null ? userText : `${current.userText}\n\n${userText}`;
        current.updatedAt = timestamp;
        continue;
      }
      const assistantText = codexMessageText(record, "assistant");
      if (assistantText !== null) {
        current.assistantText = joinCodexAssistantText(current.assistantText, assistantText);
        current.updatedAt = timestamp;
      }
    }
  }

  return turns;
}

async function resolveCodexSessionHistorySource(
  ctx: BackendSessionHistorySourceContext,
): Promise<BackendSessionHistorySourceResult> {
  const root = codexSessionsRoot();
  if (!existsSync(root)) {
    return { available: false, reason: `codex sessions root not found: ${root}` };
  }
  if (
    ctx.previousSource?.kind === "file" &&
    existsSync(ctx.previousSource.path) &&
    realFileIsUnderRoot(root, ctx.previousSource.path) &&
    codexFileNameMatchesSession(ctx.previousSource.path, ctx.sessionId)
  ) {
    return { available: true, source: sessionHistoryFileSource(ctx.previousSource.path) };
  }
  for (const path of codexSessionHistoryPathCandidates(root, ctx.sessionId)) {
    if (existsSync(path) && realFileIsUnderRoot(root, path)) {
      return { available: true, source: sessionHistoryFileSource(path) };
    }
  }
  return {
    available: false,
    reason: `codex session "${ctx.sessionId}" not found at expected rollout paths under ${root}`,
  };
}

function codexFileNameMatchesSession(path: string, sessionId: string): boolean {
  return path.endsWith(`-${sessionId}.jsonl`);
}

function uuidV7UnixMs(sessionId: string): number | null {
  const compact = sessionId.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{12}/.test(compact)) {
    return null;
  }
  const timestampMs = Number.parseInt(compact.slice(0, 12), 16);
  return Number.isSafeInteger(timestampMs) ? timestampMs : null;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function codexRolloutTimestampParts(date: Date, zone: "local" | "utc") {
  const year = zone === "local" ? date.getFullYear() : date.getUTCFullYear();
  const month = (zone === "local" ? date.getMonth() : date.getUTCMonth()) + 1;
  const day = zone === "local" ? date.getDate() : date.getUTCDate();
  const hour = zone === "local" ? date.getHours() : date.getUTCHours();
  const minute = zone === "local" ? date.getMinutes() : date.getUTCMinutes();
  const second = zone === "local" ? date.getSeconds() : date.getUTCSeconds();
  return {
    year: year.toString(),
    month: padDatePart(month),
    day: padDatePart(day),
    hour: padDatePart(hour),
    minute: padDatePart(minute),
    second: padDatePart(second),
  };
}

function codexSessionHistoryPathCandidates(root: string, sessionId: string): string[] {
  const timestampMs = uuidV7UnixMs(sessionId);
  if (timestampMs === null) {
    return [];
  }
  const candidates = new Set<string>();
  for (const zone of ["local", "utc"] as const) {
    for (let offsetSeconds = -5; offsetSeconds <= 5; offsetSeconds++) {
      const parts = codexRolloutTimestampParts(new Date(timestampMs + offsetSeconds * 1000), zone);
      candidates.add(
        join(
          root,
          parts.year,
          parts.month,
          parts.day,
          `rollout-${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${sessionId}.jsonl`,
        ),
      );
    }
  }
  return Array.from(candidates);
}

async function readCodexSessionHistory(
  ctx: BackendSessionHistoryContext,
): Promise<BackendSessionHistoryResult> {
  if (ctx.source.kind !== "file") {
    throw new Error("codex session history source must be a file");
  }
  const source = sessionHistoryFileSource(ctx.source.path);
  return {
    source,
    cursor: { kind: "file", size: source.size },
    turns: await parseCodexSessionHistoryJsonl(ctx.source.path),
  };
}

/**
 * Validate that a codex thread id exists and was created under the
 * supplied cwd. Opens a transport, completes the JSON-RPC handshake,
 * issues a single read-only `thread/read` call, and tears down. No
 * LLM call, no turn/start. Returns a structured result so the caller
 * can surface a useful error message.
 *
 * `thread/read` returns a `Thread` whose `cwd: PathBuf` field carries
 * the working directory captured when the thread was created
 * (codex-rs/.../v2.rs Thread struct, field `cwd`). We enforce a
 * strict equality check against the cwd we're about to operate
 * under: codex itself allows mismatched cwd on resume but it almost
 * always means the user is confused, and silent semantic drift is
 * worse than a hard error.
 */
async function validateCodexSession(ctx: ValidateSessionContext): Promise<ValidateSessionResult> {
  try {
    const thread = await readCodexThread(ctx);
    const threadCwd = thread.cwd;
    if (threadCwd !== null && threadCwd !== ctx.cwd) {
      return {
        valid: false,
        reason: `codex thread "${ctx.sessionId}" was created under cwd "${threadCwd}",\n  but this run's cwd is "${ctx.cwd}". Pass --cwd ${threadCwd} to import\n  this thread, or use a different thread id.`,
      };
    }
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      reason: `codex thread "${ctx.sessionId}" not found: ${(err as Error).message}`,
    };
  }
}

export async function setCodexThreadName(ctx: {
  threadId: string;
  cwd: string;
  processCwd?: string;
  env?: Record<string, string>;
  backendConfig?: unknown;
  resolvedBackendArgs: string[];
  name: string | null;
}): Promise<void> {
  let transport: Transport | undefined;
  let client: CodexClient | undefined;
  try {
    transport = await openTransport({
      prompt: "",
      cwd: ctx.cwd,
      processCwd: ctx.processCwd,
      env: ctx.env ?? (process.env as Record<string, string>),
      backendConfig: ctx.backendConfig,
      resolvedBackendArgs: ctx.resolvedBackendArgs,
      timeoutSec: 60,
    });
    client = createClient(transport);

    await client.call("initialize", {
      clientInfo: {
        name: "task-runner",
        title: "task-runner",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.sendNotification("initialized");

    await client.call("thread/name/set", {
      threadId: ctx.threadId,
      name: ctx.name,
    });
  } finally {
    await closeCodexConnection(client, transport);
  }
}

export const codexBackend: Backend = {
  id: "codex",
  launcherApplies: ({ backendConfig }) => {
    const transportType = resolveCodexTransportConfig({ backendConfig }).type;
    return transportType !== "ws" && transportType !== "uds";
  },
  resolveConfig: resolveCodexBackendConfig,
  validateSessionId: validateCodexSession,
  resolveSessionHistorySource: resolveCodexSessionHistorySource,
  readSessionHistory: readCodexSessionHistory,
  renameSession: ({ sessionId, cwd, processCwd, env, backendConfig, resolvedBackendArgs, name }) =>
    setCodexThreadName({
      threadId: sessionId,
      cwd,
      processCwd,
      env,
      backendConfig,
      resolvedBackendArgs,
      name,
    }),
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const startedAt = Date.now();
    const rawStdoutChunks: string[] = [];
    let transport: Transport | undefined;
    let client: CodexClient | undefined;
    let timedOut = false;
    let aborted = false;
    let abortRequested = false;
    let diagnostics = "";

    const emitBackendNotice = (text: string): void => {
      diagnostics += text;
      ctx.emit?.({ type: "backend_notice", text });
    };

    const state = makeAccumulatorState(ctx);

    try {
      transport = await openTransport(ctx);

      // Stderr goes straight to the run loop's stderr sink; raw JSON-RPC
      // capture is wired into the client itself so both incoming and
      // outgoing frames land in the attempt log.
      transport.onStderr((text) => {
        ctx.emit?.({ type: "backend_notice", text });
      });

      client = createClient(transport, {
        onRawIncoming: (line) => rawStdoutChunks.push(`> ${line}`),
        onRawOutgoing: (line) => rawStdoutChunks.push(`< ${line}`),
      });
      client.notify((method, params) => handleNotification(state, method, params));

      // 1. initialize (request/response)
      await client.call("initialize", {
        clientInfo: {
          name: "task-runner",
          title: "task-runner",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });

      // 1a. initialized notification — LSP-style handshake. Codex expects
      // this after the initialize response before any thread request.
      client.sendNotification("initialized");

      // 2. thread/start or thread/resume
      let threadIdFromStart: string | null = null;
      if (ctx.resumeSessionId) {
        const result = await client.call<unknown>(
          "thread/resume",
          buildCodexThreadParams(ctx, { threadId: ctx.resumeSessionId }),
        );
        if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") {
          threadIdFromStart = result.thread.id;
        }
      } else {
        const result = await client.call<unknown>("thread/start", buildCodexThreadParams(ctx));
        if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") {
          threadIdFromStart = result.thread.id;
        }
      }
      if (threadIdFromStart) {
        state.threadId = threadIdFromStart;
      }

      if (!state.threadId) {
        throw new Error("codex: thread/start did not return a thread id");
      }

      // 2a. thread/name/set — set the thread's display name when the
      // assignment provided one. Always send (idempotent on the codex
      // side); skipped silently if a prior session already set the same
      // value. Errors are non-fatal — naming is best-effort.
      if (ctx.name) {
        try {
          await client.call("thread/name/set", {
            threadId: state.threadId,
            name: ctx.name,
          });
        } catch (err) {
          emitBackendNotice(`codex: thread/name/set failed: ${(err as Error).message}\n`);
        }
      }

      // 3. turn/start — send prompt and wait for turn/completed notification.
      const turnCompletedPromise = new Promise<void>((resolve) => {
        state.resolveCompleted = resolve;
      });

      // turn/start is usually minimal because thread/start persists the
      // model/runtime overrides, but unrestricted runs must restate their
      // policy explicitly because app-server resolves sandboxing from RPC
      // params, not from the outer `codex app-server` process argv.
      const turnStartPayload = buildCodexTurnStartPayload(
        state.threadId,
        ctx.prompt,
        ctx.unrestricted ?? false,
      );

      const turnTimeoutMs = ctx.timeoutSec * 1000;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const turnDeadline = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), turnTimeoutMs);
      });

      // Wait for an external abort signal (Ctrl+C). Resolves to "abort"
      // and cleans up its listener when the race settles.
      let abortListener: (() => void) | undefined;
      const turnAbort = new Promise<"abort">((resolve) => {
        if (!ctx.abortSignal) return;
        if (ctx.abortSignal.aborted) {
          resolve("abort");
          return;
        }
        abortListener = () => resolve("abort");
        ctx.abortSignal.addEventListener("abort", abortListener, { once: true });
      });
      let detachListener: (() => void) | undefined;
      const transportConfig = resolveCodexTransportConfig(ctx);
      const turnDetach = new Promise<"detach">((resolve) => {
        if (
          !ctx.detachSignal ||
          (transportConfig.type !== "ws" && transportConfig.type !== "uds")
        ) {
          return;
        }
        if (ctx.detachSignal.aborted) {
          resolve("detach");
          return;
        }
        detachListener = () => resolve("detach");
        ctx.detachSignal.addEventListener("abort", detachListener, { once: true });
      });

      // Fire turn/start and wait for either completion, timeout, or abort.
      const turnStartPromise = client
        .call<unknown>("turn/start", turnStartPayload)
        .then((result) => {
          if (isRecord(result) && isRecord(result.turn) && typeof result.turn.id === "string") {
            setTurnId(state, result.turn.id);
          }
        });

      const race = await Promise.race([
        Promise.all([turnStartPromise, turnCompletedPromise]).then(() => "done" as const),
        turnDeadline,
        turnAbort,
        turnDetach,
      ]);

      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortListener && ctx.abortSignal) {
        ctx.abortSignal.removeEventListener("abort", abortListener);
      }
      if (detachListener && ctx.detachSignal) {
        ctx.detachSignal.removeEventListener("abort", detachListener);
      }

      if (race === "detach") {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: false,
          detached: true,
          sessionId: state.threadId,
          transcript: null,
          rawStdout: rawStdoutChunks.join("\n"),
          rawStderr: `${client.stderr}${diagnostics}`,
        };
      }

      if (race === "timeout") {
        timedOut = true;
        await interruptTurnWithRetry(client, state);
      }

      if (race === "abort") {
        abortRequested = true;
        const interrupt = await confirmInterrupt(client, state);
        if (interrupt.confirmed) {
          aborted = true;
        } else {
          const detail = (() => {
            switch (interrupt.reason) {
              case "missing_turn_id":
                return "no turn id was available before the interrupt handshake window expired";
              case "rpc_error":
                return `turn/interrupt failed: ${interrupt.errorMessage ?? "unknown error"}`;
              case "timeout":
                return "no interrupted terminal event arrived before the confirmation timeout expired";
              case "wrong_terminal_status":
                return `turn finished with status ${interrupt.turnStatus ?? "unknown"} instead of interrupted`;
            }
          })();
          emitBackendNotice(
            `codex: Ctrl+C did not confirm remote interruption (${detail}). The remote session may still be active.\n`,
          );
        }
      }

      // Detect a turn that codex marked `interrupted` without any
      // input from us. This happens when another client connected to
      // the same codex thread (e.g. a developer using the codex CLI
      // alongside task-runner) cancels the turn from the side. The
      // run loop should treat this as a clean abort, not as a
      // failure that triggers another retry.
      if (isExternalInterrupt(state.turnStatus, timedOut, aborted || abortRequested)) {
        aborted = true;
        const taskRunnerCmd = resolveTaskRunnerCommand();
        emitBackendNotice(
          `\ncodex: turn was interrupted externally (e.g. cancelled from another client connected to the same thread); marking the run aborted instead of retrying. Resume with \`${taskRunnerCmd} run --resume-run <id>\` when ready.\n`,
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      emitBackendNotice(`${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut,
        aborted,
        sessionId: state.threadId,
        transcript: null,
        rawStdout: rawStdoutChunks.join("\n"),
        rawStderr: `${client?.stderr ?? ""}${diagnostics}`,
      };
    } finally {
      await client?.close().catch(() => {});
    }

    const stderrAccumulated = client?.stderr ?? "";
    const transcript = composePersistedTranscript(state.streamedText, state.completedText);
    const fallbackDelta = silentTranscriptFallback(state.streamedText, transcript);
    if (fallbackDelta) {
      ctx.emit?.({ type: "agent_message_delta", text: fallbackDelta });
    }

    const exitCode = (() => {
      if (timedOut || aborted) return 1;
      if (state.turnStatus === "completed") return 0;
      if (state.turnStatus === "failed" || state.turnStatus === "interrupted") return 1;
      return 1; // unknown / incomplete
    })();

    const durationMs = Date.now() - startedAt;
    void durationMs;

    return {
      exitCode,
      signal: null,
      timedOut,
      aborted,
      sessionId: state.threadId,
      transcript,
      rawStdout: rawStdoutChunks.join("\n"),
      rawStderr: `${stderrAccumulated}${diagnostics}`,
    };
  },
};

// Exported for tests
export { mapEffortToCodex, normalizeCodexModel };
export type { Transport, CodexClient };

export function isCodexAuthFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return CODEX_AUTH_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}
