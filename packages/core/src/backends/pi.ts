import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Backend,
  BackendInvokeContext,
  BackendInvokeResult,
  BackendSessionHistoryContext,
  BackendSessionHistoryResult,
  BackendSessionHistorySourceContext,
  BackendSessionHistorySourceResult,
  BackendSyncedTurn,
  EffortLevel,
  ValidateSessionContext,
  ValidateSessionResult,
} from "../core/backends/types.js";
import { buildSpawnCommand } from "../util/spawn.js";
import {
  type LineFeeder,
  composePersistedTranscript,
  createLineFeeder,
  isRecord,
  readJsonlRecordLines,
  realFileIsUnderRoot,
  sessionHistoryFileSource,
  silentTranscriptFallback,
  streamBoundarySeparator,
} from "./shared.js";

const PI_FIXED_ARGS = ["--mode", "rpc", "--no-themes"] as const;
const SHUTDOWN_GRACE_MS = 1_000;
const KILL_GRACE_MS = 5_000;
const AUTO_CANCEL_EXTENSION_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const IGNORED_EXTENSION_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

interface PiSessionHeader {
  type: "session";
  cwd: string;
}

interface PiResponse {
  id?: number;
  type?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
}

interface PendingRequest {
  command: string;
  resolve: (value: PiResponse) => void;
  reject: (error: Error) => void;
}

interface PiProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  rawStdout: string;
  rawStderr: string;
  timedOut: boolean;
  aborted: boolean;
}

interface PiStreamState {
  streamedText: string;
  completedTexts: string[];
  activeAssistantText: string;
  activeAssistantOpen: boolean;
  activeAssistantSeen: boolean;
  agentEnded: boolean;
  onText: (text: string) => void;
}

function mapEffortToPi(effort: EffortLevel): string | null {
  switch (effort) {
    case "off":
      return "off";
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

export function buildPiArgs(
  ctx: Pick<BackendInvokeContext, "effort" | "model" | "resolvedBackendArgs" | "resumeSessionId">,
): string[] {
  const args: string[] = [...PI_FIXED_ARGS];
  if (ctx.model) {
    args.push("--model", ctx.model);
  }
  if (ctx.effort) {
    const mapped = mapEffortToPi(ctx.effort);
    if (mapped) {
      args.push("--thinking", mapped);
    }
  }
  if (ctx.resumeSessionId) {
    args.push("--session", ctx.resumeSessionId);
  }
  args.push(...ctx.resolvedBackendArgs);
  return args;
}

const PI_SESSION_HEADER_READ_CHUNK_SIZE = 4_096;
const PI_SESSION_HEADER_READ_LIMIT = 65_536;
const PI_TIMESTAMPED_SESSION_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)\.jsonl$/u;

function readFirstLineSync(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < PI_SESSION_HEADER_READ_LIMIT) {
      const chunk = Buffer.allocUnsafe(
        Math.min(PI_SESSION_HEADER_READ_CHUNK_SIZE, PI_SESSION_HEADER_READ_LIMIT - bytesReadTotal),
      );
      const bytesRead = readSync(fd, chunk, 0, chunk.length, bytesReadTotal);
      if (bytesRead === 0) {
        break;
      }
      const used = chunk.subarray(0, bytesRead);
      const newlineIndex = used.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(used.subarray(0, newlineIndex));
        return Buffer.concat(chunks).toString("utf8").replace(/\r$/u, "");
      }
      chunks.push(used);
      bytesReadTotal += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r$/u, "");
  } finally {
    closeSync(fd);
  }
}

function parsePiSessionHeader(sessionPath: string): PiSessionHeader {
  const firstLine = readFirstLineSync(sessionPath);
  if (firstLine.trim().length === 0) {
    throw new Error("session file is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    throw new Error(
      `session header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed) || parsed.type !== "session" || typeof parsed.cwd !== "string") {
    throw new Error('session header must be an object with type "session" and string cwd');
  }

  return {
    type: "session",
    cwd: parsed.cwd,
  };
}

export function readPiSessionHeader(sessionPath: string): PiSessionHeader {
  return parsePiSessionHeader(sessionPath);
}

function piHomeRoot(): string {
  return process.env.PI_HOME?.trim() || join(homedir(), ".pi");
}

/**
 * Pi stores cwd-scoped sessions under `agent/sessions/<encoded-cwd>/`
 * using leading/trailing `--` sentinels and `/ -> -` path folding while
 * leaving dots intact. Observed examples on disk:
 * `/home/kevin/assistant` -> `--home-kevin-assistant--`
 * `/home/kevin/.agents` -> `--home-kevin-.agents--`
 */
export function encodePiSessionDir(cwd: string): string {
  return `--${cwd.replaceAll("/", "-").replace(/^-+/, "")}--`;
}

function piSessionsBucketDir(cwd: string): string {
  return join(piHomeRoot(), "agent", "sessions", encodePiSessionDir(cwd));
}

function piSessionFileNameMatches(name: string, sessionId: string): boolean {
  const match = PI_TIMESTAMPED_SESSION_FILE_RE.exec(name);
  return match?.[1] === sessionId;
}

export function findPiSessionFile(cwd: string, sessionId: string): string | null {
  const bucketDir = piSessionsBucketDir(cwd);
  try {
    const matches: string[] = [];
    for (const entry of readdirSync(bucketDir, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (piSessionFileNameMatches(entry.name, sessionId)) {
        matches.push(entry.name);
      }
    }
    const match = matches.sort().at(-1);
    return match === undefined ? null : join(bucketDir, match);
  } catch {
    return null;
  }
}

type ResolvedPiSessionFile =
  | { ok: true; path: string; header: PiSessionHeader }
  | { ok: false; reason: string };

function resolvePiSessionFile(cwd: string, rawSessionId: string): ResolvedPiSessionFile {
  const sessionId = rawSessionId.trim();
  if (sessionId.length === 0) {
    return { ok: false, reason: "pi session id cannot be empty" };
  }
  const bucketDir = piSessionsBucketDir(cwd);
  const sessionPath = findPiSessionFile(cwd, sessionId);
  if (sessionPath === null) {
    return {
      ok: false,
      reason: `pi session "${sessionId}" not found under cwd "${cwd}"\n  expected directory: ${bucketDir}\n  the session must have been created with the same working directory; pi keys session storage by encoded cwd.`,
    };
  }
  if (!realFileIsUnderRoot(bucketDir, sessionPath)) {
    return { ok: false, reason: "pi session file escaped the cwd bucket" };
  }

  let header: PiSessionHeader;
  try {
    header = readPiSessionHeader(sessionPath);
  } catch (error) {
    return {
      ok: false,
      reason: `pi session "${sessionId}" has an unreadable header: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (header.cwd !== cwd) {
    return {
      ok: false,
      reason: `pi session "${sessionId}" belongs to cwd "${header.cwd}", not "${cwd}"`,
    };
  }
  return { ok: true, path: sessionPath, header };
}

async function validatePiSession(ctx: ValidateSessionContext): Promise<ValidateSessionResult> {
  const resolved = resolvePiSessionFile(ctx.cwd, ctx.sessionId);
  return resolved.ok ? { valid: true } : { valid: false, reason: resolved.reason };
}

interface PiHistoryTurnBuilder {
  backendTurnId: string;
  startedAt: string;
  updatedAt: string;
  userText: string;
  assistantText: string;
}

function extractPiMessageText(
  message: Record<string, unknown>,
  role: "user" | "assistant",
): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  let combined = "";
  for (const item of content) {
    if (role === "assistant" && isRecord(item) && item.type !== "text") continue;
    if (isRecord(item) && typeof item.text === "string") {
      combined += item.text;
    }
  }
  return combined;
}

function piHistoryTurnId(
  record: Record<string, unknown>,
  sessionId: string,
  lineNumber: number,
): string {
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id;
  }
  return `pi:${sessionId}:line:${lineNumber}`;
}

function finishPiTurn(
  turns: BackendSyncedTurn[],
  current: PiHistoryTurnBuilder,
  status: "complete" | "open",
): void {
  turns.push({
    backendTurnId: current.backendTurnId,
    status,
    startedAt: current.startedAt,
    updatedAt: current.updatedAt,
    userText: current.userText,
    assistantText: current.assistantText.length > 0 ? current.assistantText : null,
  });
}

export async function parsePiSessionHistoryJsonl(params: {
  path: string;
  sessionId: string;
  mode: "bootstrap" | "sync";
}): Promise<BackendSyncedTurn[]> {
  const records = await readJsonlRecordLines(params.path, "Pi");
  const header = records[0]?.record;
  if (header === undefined) {
    throw new Error("Pi session history is empty");
  }
  if (header.type !== "session") {
    throw new Error('Pi session history first record must have type "session"');
  }

  const turns: BackendSyncedTurn[] = [];
  let current: PiHistoryTurnBuilder | null = null;

  let isHeaderRecord = true;
  for (const { record, lineNumber } of records) {
    if (isHeaderRecord) {
      isHeaderRecord = false;
      continue;
    }
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    if (record.type !== "message" || !isRecord(record.message)) {
      continue;
    }
    const message = record.message;
    const role = message.role;
    if (role === "user" && timestamp !== null) {
      if (current !== null && current.assistantText.length > 0) {
        finishPiTurn(turns, current, "complete");
      }
      current = {
        backendTurnId: piHistoryTurnId(record, params.sessionId, lineNumber),
        startedAt: timestamp,
        updatedAt: timestamp,
        userText: extractPiMessageText(message, "user"),
        assistantText: "",
      };
      continue;
    }
    if (role === "assistant" && current !== null && timestamp !== null) {
      const assistantText = extractPiMessageText(message, "assistant");
      if (assistantText.length > 0) {
        current.assistantText += streamBoundarySeparator(current.assistantText, assistantText);
        current.assistantText += assistantText;
        current.updatedAt = timestamp;
      }
    }
  }

  if (current !== null) {
    if (current.assistantText.length > 0) {
      finishPiTurn(turns, current, "complete");
    } else if (params.mode === "sync") {
      finishPiTurn(turns, current, "open");
    }
  }
  return turns;
}

async function resolvePiSessionHistorySource(
  ctx: BackendSessionHistorySourceContext,
): Promise<BackendSessionHistorySourceResult> {
  const resolved = resolvePiSessionFile(ctx.cwd, ctx.sessionId);
  if (!resolved.ok) {
    return { available: false, reason: resolved.reason };
  }
  return { available: true, source: sessionHistoryFileSource(resolved.path) };
}

async function readPiSessionHistory(
  ctx: BackendSessionHistoryContext,
): Promise<BackendSessionHistoryResult> {
  if (ctx.source.kind !== "file") {
    throw new Error("pi session history source must be a file");
  }
  const source = sessionHistoryFileSource(ctx.source.path);
  return {
    source,
    cursor: { kind: "file", size: source.size },
    turns: await parsePiSessionHistoryJsonl({
      path: ctx.source.path,
      sessionId: ctx.sessionId,
      mode: ctx.mode,
    }),
  };
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  return extractPiMessageText(message, "assistant");
}

function emitAssistantUpdate(state: PiStreamState, nextText: string): void {
  const priorText = state.activeAssistantSeen ? state.activeAssistantText : "";
  let delta = "";
  if (nextText.startsWith(priorText)) {
    delta = nextText.slice(priorText.length);
  } else if (nextText !== priorText) {
    delta = nextText;
  }

  state.activeAssistantText = nextText;
  state.activeAssistantSeen = true;

  if (delta.length === 0) return;

  if (!state.activeAssistantOpen) {
    const separator = streamBoundarySeparator(state.streamedText, delta);
    if (separator.length > 0) {
      state.streamedText += separator;
      state.onText(separator);
    }
    state.activeAssistantOpen = true;
  }

  state.streamedText += delta;
  state.onText(delta);
}

function handlePiEvent(
  event: Record<string, unknown>,
  state: PiStreamState,
  send: (payload: Record<string, unknown>) => void,
  emitBackendNotice: (text: string) => void,
  resolveAgentEnd: () => void,
): void {
  switch (event.type) {
    case "message_start": {
      if (isRecord(event.message) && event.message.role === "assistant") {
        state.activeAssistantText = "";
        state.activeAssistantOpen = false;
        state.activeAssistantSeen = false;
      }
      return;
    }
    case "message_update": {
      if (isRecord(event.message) && event.message.role === "assistant") {
        emitAssistantUpdate(state, extractAssistantText(event.message));
      }
      return;
    }
    case "message_end": {
      if (isRecord(event.message) && event.message.role === "assistant") {
        const finalText = extractAssistantText(event.message);
        emitAssistantUpdate(state, finalText);
        if (finalText.trim().length > 0) {
          state.completedTexts.push(finalText.trim());
        }
      }
      return;
    }
    case "agent_end": {
      resolveAgentEnd();
      return;
    }
    case "extension_ui_request": {
      const requestId =
        typeof event.id === "string" || typeof event.id === "number" ? event.id : null;
      const method = typeof event.method === "string" ? event.method : "";
      if (requestId === null) {
        emitBackendNotice("pi: extension_ui_request missing id\n");
        return;
      }
      if (AUTO_CANCEL_EXTENSION_UI_METHODS.has(method)) {
        send({
          type: "extension_ui_response",
          id: requestId,
          cancelled: true,
        });
        return;
      }
      if (IGNORED_EXTENSION_UI_METHODS.has(method)) {
        return;
      }
      emitBackendNotice(`pi: ignoring unsupported extension_ui_request method "${method}"\n`);
      return;
    }
    case "extension_error": {
      const extensionPath =
        typeof event.extensionPath === "string" ? event.extensionPath : "<unknown>";
      const error = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
      emitBackendNotice(`pi extension error (${extensionPath}): ${error}\n`);
      return;
    }
  }
}

function composePiTranscript(state: PiStreamState): string | null {
  const finalText = state.completedTexts.length > 0 ? state.completedTexts.join("\n\n") : null;
  return composePersistedTranscript(state.streamedText, finalText);
}

function createPiProcess(ctx: BackendInvokeContext): Promise<{
  call: (command: string, payload: Record<string, unknown>) => Promise<PiResponse>;
  waitForAgentEnd: () => Promise<void>;
  closeInput: () => void;
  getTranscript: () => string | null;
  getStreamedText: () => string;
  waitForExit: () => Promise<PiProcessResult>;
}> {
  return new Promise((resolve, reject) => {
    const command = process.env.TASK_RUNNER_PI_BIN ?? "pi";
    const launched = buildSpawnCommand({
      command,
      args: buildPiArgs(ctx),
      launcher: ctx.launcher,
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launched.command, launched.args, {
        cwd: ctx.processCwd ?? ctx.cwd,
        env: ctx.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    let timedOut = false;
    let aborted = false;
    let closed = false;
    let exitResult: PiProcessResult | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let shutdownTimer: NodeJS.Timeout | null = null;
    let agentEndError: Error | null = null;
    let agentEndPromise: Promise<void> | null = null;
    let agentEndResolve: (() => void) | null = null;
    let agentEndReject: ((error: Error) => void) | null = null;

    const state: PiStreamState = {
      streamedText: "",
      completedTexts: [],
      activeAssistantText: "",
      activeAssistantOpen: false,
      activeAssistantSeen: false,
      agentEnded: false,
      onText: (text) => ctx.emit?.({ type: "agent_message_delta", text }),
    };

    const emitBackendNotice = (text: string): void => {
      ctx.emit?.({ type: "backend_notice", text });
    };

    const resolveAgentEnd = (): void => {
      if (state.agentEnded || agentEndError !== null) {
        return;
      }
      state.agentEnded = true;
      agentEndResolve?.();
      agentEndResolve = null;
      agentEndReject = null;
    };

    const rejectAgentEnd = (error: Error): void => {
      if (state.agentEnded || agentEndError !== null) {
        return;
      }
      agentEndError = error;
      agentEndReject?.(error);
      agentEndReject = null;
      agentEndResolve = null;
    };

    const settleRequestsWithError = (error: Error): void => {
      for (const entry of pending.values()) {
        queueMicrotask(() => {
          entry.reject(error);
        });
      }
      pending.clear();
      rejectAgentEnd(error);
    };

    const finalizeProcess = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (exitResult !== null) {
        return;
      }

      closed = true;
      clearTimeout(timeoutHandle);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (killTimer) clearTimeout(killTimer);
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      lineFeeder.flush();

      if (pending.size > 0 || !state.agentEnded) {
        settleRequestsWithError(
          new Error(
            `pi exited before finishing (exit=${exitCode ?? "null"} signal=${signal ?? "null"})`,
          ),
        );
      }

      exitResult = {
        exitCode,
        signal,
        rawStdout: Buffer.concat(stdoutChunks).toString("utf8"),
        rawStderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        aborted,
      };
    };

    const requireExitResult = (): PiProcessResult => {
      if (exitResult === null) {
        throw new Error("pi process exit result was not captured");
      }
      return exitResult;
    };

    const scheduleKill = (signal: NodeJS.Signals): void => {
      if (killTimer !== null) return;
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill(signal);
          } catch {
            // ignore
          }
        }
      }, KILL_GRACE_MS);
    };

    const requestAbort = (): void => {
      if (closed) return;
      try {
        child.stdin?.write(`${JSON.stringify({ type: "abort", id: nextId++ })}\n`);
      } catch {
        // ignore
      }
      if (shutdownTimer !== null) return;
      shutdownTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGINT");
          } catch {
            // ignore
          }
          scheduleKill("SIGKILL");
        }
      }, SHUTDOWN_GRACE_MS);
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      requestAbort();
    }, ctx.timeoutSec * 1000);

    const onAbort = (): void => {
      aborted = true;
      requestAbort();
    };

    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        aborted = true;
        requestAbort();
      } else {
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const send = (payload: Record<string, unknown>): void => {
      if (closed) return;
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // ignore
      }
    };

    const call = (command: string, payload: Record<string, unknown>): Promise<PiResponse> => {
      const id = nextId++;
      return new Promise<PiResponse>((resolveResponse, rejectResponse) => {
        pending.set(id, {
          command,
          resolve: resolveResponse,
          reject: rejectResponse,
        });
        send({ id, ...payload });
      });
    };

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      if (!trimmed.startsWith("{")) {
        const error = new Error(`pi rpc emitted a non-JSON line: ${trimmed}`);
        settleRequestsWithError(error);
        requestAbort();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        settleRequestsWithError(
          new Error(
            `pi rpc emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        requestAbort();
        return;
      }

      if (!isRecord(parsed)) {
        settleRequestsWithError(new Error("pi rpc emitted a non-object JSON record"));
        requestAbort();
        return;
      }

      if (parsed.type === "response") {
        const id = typeof parsed.id === "number" ? parsed.id : null;
        if (id === null) {
          settleRequestsWithError(new Error("pi rpc response is missing numeric id"));
          requestAbort();
          return;
        }
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        const response = parsed as PiResponse;
        if (response.success === false) {
          entry.reject(
            new Error(
              `pi ${entry.command} failed: ${typeof response.error === "string" ? response.error : JSON.stringify(response.error)}`,
            ),
          );
          return;
        }
        entry.resolve(response);
        return;
      }

      handlePiEvent(parsed, state, send, emitBackendNotice, resolveAgentEnd);
    };

    const lineFeeder: LineFeeder = createLineFeeder({
      onLine: processLine,
      onPartial: (partial) => {
        if (partial.trim().length > 0) {
          processLine(partial);
        }
      },
      onRawSegment: ctx.onRawStdoutLine,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      lineFeeder.feed(chunk.toString("utf8"));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      emitBackendNotice(chunk.toString("utf8"));
    });

    const exitPromise = new Promise<PiProcessResult>((resolveExit) => {
      child.once("error", (error) => {
        settleRequestsWithError(error);
        finalizeProcess(child.exitCode, child.signalCode);
        resolveExit(requireExitResult());
      });

      child.once("close", (exitCode, signal) => {
        finalizeProcess(exitCode, signal);
        resolveExit(requireExitResult());
      });
    });

    resolve({
      call,
      waitForAgentEnd: () => {
        if (state.agentEnded) {
          return Promise.resolve();
        }
        if (agentEndError !== null) {
          return Promise.reject(agentEndError);
        }
        if (agentEndPromise === null) {
          agentEndPromise = new Promise<void>((resolveWaitForAgentEnd, rejectWaitForAgentEnd) => {
            agentEndResolve = resolveWaitForAgentEnd;
            agentEndReject = rejectWaitForAgentEnd;
          });
        }
        return agentEndPromise;
      },
      closeInput: () => {
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
      },
      getTranscript: () => composePiTranscript(state),
      getStreamedText: () => state.streamedText,
      waitForExit: () => exitPromise,
    });
  });
}

export async function setPiSessionName(ctx: {
  sessionId: string;
  cwd: string;
  env?: Record<string, string>;
  resolvedBackendArgs: string[];
  name: string | null;
}): Promise<void> {
  if (ctx.name === null) {
    return;
  }

  // Pi accepts both session ids and resolved session files on `--session`.
  // Prefer the on-disk file when available so rename targets the exact
  // cwd-scoped session we validated/imported.
  const renameTarget = findPiSessionFile(ctx.cwd, ctx.sessionId) ?? ctx.sessionId;
  const processHandle = await createPiProcess({
    prompt: "",
    cwd: ctx.cwd,
    env: ctx.env ?? (process.env as Record<string, string>),
    resolvedBackendArgs: ctx.resolvedBackendArgs,
    timeoutSec: 60,
    resumeSessionId: renameTarget,
    emit: () => {},
  });

  let result: PiProcessResult | null = null;
  try {
    await processHandle.call("set_session_name", {
      type: "set_session_name",
      name: ctx.name,
    });
  } finally {
    processHandle.closeInput();
    result = await processHandle.waitForExit();
  }

  if (result === null || result.exitCode !== 0) {
    throw new Error(`pi rename exited with code ${result?.exitCode ?? "null"}`);
  }
}

export const piBackend: Backend = {
  id: "pi",
  validateSessionId: validatePiSession,
  resolveSessionHistorySource: resolvePiSessionHistorySource,
  readSessionHistory: readPiSessionHistory,
  renameSession: ({ sessionId, cwd, env, resolvedBackendArgs, name }) =>
    setPiSessionName({
      sessionId,
      cwd,
      env,
      resolvedBackendArgs,
      name,
    }),
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const processHandle = await createPiProcess(ctx);

    try {
      const stateResponse = await processHandle.call("get_state", {
        type: "get_state",
      });
      const stateData = isRecord(stateResponse.data) ? stateResponse.data : {};
      const sessionId =
        typeof stateData.sessionId === "string" && stateData.sessionId.length > 0
          ? stateData.sessionId
          : null;

      if (ctx.name) {
        try {
          await processHandle.call("set_session_name", {
            type: "set_session_name",
            name: ctx.name,
          });
        } catch (error) {
          ctx.emit?.({
            type: "backend_notice",
            text: `pi: set_session_name failed: ${error instanceof Error ? error.message : String(error)}\n`,
          });
        }
      }

      await processHandle.call("prompt", {
        type: "prompt",
        message: ctx.prompt,
      });
      await processHandle.waitForAgentEnd();
      processHandle.closeInput();
      const result = await processHandle.waitForExit();
      const transcript = result.exitCode === 0 ? processHandle.getTranscript() : null;
      const fallbackDelta = silentTranscriptFallback(processHandle.getStreamedText(), transcript);
      if (fallbackDelta) {
        ctx.emit?.({ type: "agent_message_delta", text: fallbackDelta });
      }
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        sessionId,
        transcript,
        rawStdout: result.rawStdout,
        rawStderr: result.rawStderr,
      };
    } catch (error) {
      processHandle.closeInput();
      const result = await processHandle.waitForExit();
      throw error instanceof Error
        ? error
        : new Error(
            `pi invoke failed (exit=${result.exitCode ?? "null"} signal=${result.signal ?? "null"})`,
          );
    }
  },
};
