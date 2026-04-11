import { type ChildProcess, spawn } from "node:child_process";
import { WebSocket } from "ws";
import type {
  Backend,
  BackendInvokeContext,
  BackendInvokeResult,
  EffortLevel,
  ValidateSessionContext,
  ValidateSessionResult,
} from "./types.js";

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

function normalizeCodexModel(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex < 0) return model;
  const stripped = model.slice(slashIndex + 1);
  return stripped.length > 0 ? stripped : model;
}

const TURN_INTERRUPT_GRACE_MS = 1_000;

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

/**
 * Compute a paragraph-break separator to insert before `delta` so that
 * two adjacent streamed message bodies don't get glued together.
 *
 * Returns the separator string only ("" if no padding is needed). The
 * caller is responsible for emitting `separator + delta` to its sink.
 *
 * Rules:
 *   - If `prior` is empty, no separator (this is the first byte streamed).
 *   - Otherwise, ensure exactly two trailing newlines on the joined
 *     stream — accounting for any newlines already at the end of `prior`
 *     and at the start of `delta`. Two newlines render as a paragraph
 *     break in a terminal.
 */
function streamBoundarySeparator(prior: string, delta: string): string {
  if (prior.length === 0) return "";
  let trailing = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    if (prior[i] === "\n") trailing++;
    else break;
  }
  let leading = 0;
  for (let i = 0; i < delta.length; i++) {
    if (delta[i] === "\n") leading++;
    else break;
  }
  const needed = Math.max(0, 2 - trailing - leading);
  return "\n".repeat(needed);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function openStdioTransport(cwd: string, env: Record<string, string>): Transport {
  const binary = process.env.TASK_RUNNER_CODEX_BIN ?? "codex";
  const child: ChildProcess = spawn(binary, ["app-server"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let messageHandler: ((line: string) => void) | null = null;
  let stderrHandler: ((text: string) => void) | null = null;
  let closeHandler: ((code: number | null, reason: string) => void) | null = null;
  let closed = false;
  let stdoutBuffer = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIdx);
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line.trim().length > 0 && messageHandler) {
        messageHandler(line);
      }
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrHandler?.(chunk.toString("utf8"));
  });

  child.on("close", (code, signal) => {
    if (closed) return;
    closed = true;
    closeHandler?.(code, signal ? `signal ${signal}` : "exit");
  });
  child.on("error", (err) => {
    if (closed) return;
    closed = true;
    closeHandler?.(null, `spawn error: ${err.message}`);
  });

  return {
    descriptor: `stdio:${binary}`,
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
// WebSocket transport — connects to TASK_RUNNER_CODEX_WS_URL
// ─────────────────────────────────────────────────────────────────────────────

function openWsTransport(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    let messageHandler: ((line: string) => void) | null = null;
    let stderrHandler: ((text: string) => void) | null = null;
    let closeHandler: ((code: number | null, reason: string) => void) | null = null;
    let closed = false;

    ws.on("open", () => {
      resolve({
        descriptor: `ws:${url}`,
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
      stderrHandler?.(`ws error: ${err.message}\n`);
      if (!closed) {
        closed = true;
        reject(err);
      }
    });
    ws.on("close", (code, reason) => {
      if (closed) return;
      closed = true;
      closeHandler?.(code, reason.toString("utf8") || "close");
    });
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
    } catch {
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
  onText: (text: string) => void;
  resolveCompleted: (() => void) | null;
}

function setTurnId(state: AccumulatorState, turnId: string): void {
  if (state.turnId) return;
  state.turnId = turnId;
  const waiters = state.turnIdWaiters.splice(0);
  for (const waiter of waiters) waiter(turnId);
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

export async function interruptTurnWithGrace(
  client: Pick<CodexClient, "call">,
  state: AccumulatorState,
  timeoutMs = TURN_INTERRUPT_GRACE_MS,
): Promise<boolean> {
  const turnId = await waitForTurnId(state, timeoutMs);
  if (!state.threadId || !turnId) return false;
  try {
    await client.call("turn/interrupt", {
      threadId: state.threadId,
      turnId,
    });
    return true;
  } catch {
    return false;
  }
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
      if (isRecord(thread) && typeof thread.id === "string") {
        state.threadId = thread.id;
      }
      return;
    }
    case "turn/started": {
      const turn = params.turn;
      if (isRecord(turn) && typeof turn.id === "string") {
        setTurnId(state, turn.id);
      }
      return;
    }
    case "item/agentMessage/delta": {
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
      state.turnCompleted = true;
      state.resolveCompleted?.();
      return;
    }
    case "error": {
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

async function openTransport(ctx: BackendInvokeContext): Promise<Transport> {
  const wsUrl = process.env.TASK_RUNNER_CODEX_WS_URL;
  if (wsUrl && wsUrl.length > 0) {
    return openWsTransport(wsUrl);
  }
  return openStdioTransport(ctx.cwd, ctx.env);
}

function buildThreadParams(
  ctx: BackendInvokeContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    cwd: ctx.cwd,
    ...extra,
  };
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
  }
  return params;
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
  let transport: Transport | undefined;
  let client: CodexClient | undefined;
  try {
    transport = await openTransport({
      // Only cwd/env are read by openTransport. The rest of
      // BackendInvokeContext is unused for the validation handshake.
      prompt: "",
      cwd: ctx.cwd,
      env: ctx.env ?? (process.env as Record<string, string>),
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

    const result = await client.call<unknown>("thread/read", {
      threadId: ctx.sessionId,
    });

    if (!isRecord(result) || !isRecord(result.thread)) {
      return {
        valid: false,
        reason: `codex thread/read for "${ctx.sessionId}" returned an unexpected response shape`,
      };
    }
    const threadCwd = typeof result.thread.cwd === "string" ? result.thread.cwd : null;
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
  } finally {
    await client?.close().catch(() => {});
  }
}

export const codexBackend: Backend = {
  id: "codex",
  validateSessionId: validateCodexSession,
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const startedAt = Date.now();
    const rawStdoutChunks: string[] = [];
    let transport: Transport | undefined;
    let client: CodexClient | undefined;
    let timedOut = false;
    let aborted = false;

    const state: AccumulatorState = {
      threadId: null,
      turnId: null,
      turnIdWaiters: [],
      streamedText: "",
      completedText: "",
      lastStreamItemId: null,
      turnStatus: "in_progress",
      turnError: null,
      turnCompleted: false,
      onText: (text) => ctx.onStdoutText?.(text),
      resolveCompleted: null,
    };

    try {
      transport = await openTransport(ctx);

      // Stderr goes straight to the run loop's stderr sink; raw JSON-RPC
      // capture is wired into the client itself so both incoming and
      // outgoing frames land in the attempt log.
      transport.onStderr((text) => {
        ctx.onStderrText?.(text);
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
          buildThreadParams(ctx, { threadId: ctx.resumeSessionId }),
        );
        if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === "string") {
          threadIdFromStart = result.thread.id;
        }
      } else {
        const result = await client.call<unknown>("thread/start", buildThreadParams(ctx));
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
      if (ctx.sessionName) {
        try {
          await client.call("thread/name/set", {
            threadId: state.threadId,
            name: ctx.sessionName,
          });
        } catch (err) {
          ctx.onStderrText?.(`codex: thread/name/set failed: ${(err as Error).message}\n`);
        }
      }

      // 3. turn/start — send prompt and wait for turn/completed notification.
      const turnCompletedPromise = new Promise<void>((resolve) => {
        state.resolveCompleted = resolve;
      });

      // turn/start params are minimal — model/effort/approvalPolicy are
      // set once at thread/start (or thread/resume) time and apply for the
      // lifetime of the thread. Matches agent-runner's managed.ts.
      const turnStartPayload: Record<string, unknown> = {
        threadId: state.threadId,
        input: [{ type: "text", text: ctx.prompt }],
      };

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
      ]);

      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortListener && ctx.abortSignal) {
        ctx.abortSignal.removeEventListener("abort", abortListener);
      }

      if (race === "timeout" || race === "abort") {
        if (race === "timeout") timedOut = true;
        if (race === "abort") aborted = true;
        await interruptTurnWithGrace(client, state);
      }

      // Detect a turn that codex marked `interrupted` without any
      // input from us. This happens when another client connected to
      // the same codex thread (e.g. a developer using the codex CLI
      // alongside task-runner) cancels the turn from the side. The
      // run loop should treat this as a clean abort, not as a
      // failure that triggers another retry.
      if (isExternalInterrupt(state.turnStatus, timedOut, aborted)) {
        aborted = true;
        ctx.onStderrText?.(
          "\ncodex: turn was interrupted externally (e.g. cancelled from another " +
            "client connected to the same thread); marking the run aborted instead " +
            "of retrying. Resume with `task-runner run --resume-run <id>` when ready.\n",
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      ctx.onStderrText?.(`${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut,
        aborted,
        sessionId: state.threadId,
        transcript: null,
        rawStdout: rawStdoutChunks.join("\n"),
        rawStderr: `${client?.stderr ?? ""}${message}\n`,
      };
    } finally {
      await client?.close().catch(() => {});
    }

    const stderrAccumulated = client?.stderr ?? "";
    const transcript = state.completedText.trim() || state.streamedText.trim() || null;

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
      rawStderr: stderrAccumulated,
    };
  },
};

// Exported for tests
export { mapEffortToCodex, normalizeCodexModel, streamBoundarySeparator };
export type { Transport, CodexClient };

export function isCodexAuthFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return CODEX_AUTH_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}
