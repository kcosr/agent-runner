import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Backend, BackendInvokeContext, BackendInvokeResult } from "../core/backends/types.js";
import type {
  BackendSessionHistoryContext,
  BackendSessionHistoryResult,
  BackendSessionHistorySourceContext,
  BackendSessionHistorySourceResult,
  BackendSyncedTurn,
  ValidateSessionContext,
  ValidateSessionResult,
} from "../core/backends/types.js";
import { runProcess } from "../util/spawn.js";
import {
  type LineFeeder,
  composePersistedTranscript,
  createLineFeeder,
  isRecord,
  normalizeBackendModel,
  realFileIsUnderRoot,
  sessionHistoryFileSource,
  silentTranscriptFallback,
  streamBoundarySeparator,
} from "./shared.js";

const CURSOR_CHATS_ROOT_PARTS = [".cursor", "chats"] as const;
const CURSOR_INTERNAL_USER_PREFIXES = [
  "<user_info>",
  "<agent_transcripts>",
  "<agent_skills>",
  "<system",
] as const;

interface CursorStoreMeta {
  agentId: string;
  latestRootBlobId: string;
  createdAt: number;
}

interface CursorMessageBlob {
  id: string;
  message: Record<string, unknown>;
}

interface CursorTurnAccumulator {
  turns: BackendSyncedTurn[];
  current: CursorTurnBuilder | null;
  currentTurnIndex: number;
  createdAt: number;
}

interface CursorTurnBuilder {
  backendTurnId: string;
  startedAt: string;
  updatedAt: string;
  userText: string;
  assistantText: string;
  selectedAssistantIsFinal: boolean;
}

function cursorChatsRoot(): string {
  return join(homedir(), ...CURSOR_CHATS_ROOT_PARTS);
}

export function cursorWorkspaceHash(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

export function cursorStoreDbPath(cwd: string, sessionId: string): string {
  return join(cursorChatsRoot(), cursorWorkspaceHash(cwd), sessionId, "store.db");
}

function cursorSessionIdInvalidReason(sessionId: string): string | null {
  if (sessionId.trim().length === 0) {
    return "cursor session id cannot be empty";
  }
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId === "..") {
    return "cursor session id must be a session id, not a path";
  }
  return null;
}

function openCursorStore(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function readCursorMeta(db: Database.Database): CursorStoreMeta {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("0");
  if (!isRecord(row) || typeof row.value !== "string") {
    throw new Error('cursor store meta key "0" is missing');
  }
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(row.value)) {
    throw new Error('cursor store meta key "0" is malformed: value must be hex-encoded JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `cursor store meta key "0" is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.latestRootBlobId !== "string" ||
    typeof parsed.createdAt !== "number" ||
    !Number.isFinite(parsed.createdAt)
  ) {
    throw new Error(
      'cursor store meta key "0" must decode to JSON with string agentId, string latestRootBlobId, and numeric createdAt',
    );
  }
  return {
    agentId: parsed.agentId,
    latestRootBlobId: parsed.latestRootBlobId,
    createdAt: parsed.createdAt,
  };
}

function readCursorBlob(
  statement: Database.Statement<[string], unknown>,
  blobId: string,
): Buffer | null {
  const row = statement.get(blobId);
  if (!isRecord(row)) {
    return null;
  }
  const data = row.data;
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }
  return null;
}

function readVarint(data: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let currentOffset = offset;
  while (currentOffset < data.length) {
    const byte = data[currentOffset];
    if (byte === undefined) {
      throw new Error("malformed Cursor root blob: truncated varint");
    }
    currentOffset++;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, offset: currentOffset };
    }
    shift += 7;
    if (shift > 49) {
      throw new Error("malformed Cursor root blob: varint is too long");
    }
  }
  throw new Error("malformed Cursor root blob: truncated varint");
}

function skipFixedWidth(
  data: Uint8Array,
  offset: number,
  byteLength: number,
  wireType: number,
): number {
  const nextOffset = offset + byteLength;
  if (nextOffset > data.length) {
    throw new Error(`malformed Cursor root blob: truncated wire type ${wireType} field`);
  }
  return nextOffset;
}

export function parseCursorRootBlobMessageIds(data: Buffer | Uint8Array): string[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const ids: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    switch (wireType) {
      case 0:
        offset = readVarint(bytes, offset).offset;
        break;
      case 1:
        offset = skipFixedWidth(bytes, offset, 8, wireType);
        break;
      case 2: {
        const length = readVarint(bytes, offset);
        offset = length.offset;
        const nextOffset = offset + length.value;
        if (nextOffset > bytes.length) {
          throw new Error("malformed Cursor root blob: truncated length-delimited field");
        }
        if (fieldNumber === 1 && length.value === 32) {
          ids.push(Buffer.from(bytes.subarray(offset, nextOffset)).toString("hex"));
        }
        offset = nextOffset;
        break;
      }
      case 5:
        offset = skipFixedWidth(bytes, offset, 4, wireType);
        break;
      default:
        throw new Error(`malformed Cursor root blob: unsupported wire type ${wireType}`);
    }
  }
  return ids;
}

function cursorContentText(message: Record<string, unknown>, role: "user" | "assistant"): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  let combined = "";
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (role === "assistant" && item.type !== "text") continue;
    if (typeof item.text === "string") {
      combined += item.text;
    }
  }
  return combined;
}

function cursorVisibleUserText(message: Record<string, unknown>): string | null {
  const trimmed = cursorContentText(message, "user").trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (CURSOR_INTERNAL_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return null;
  }
  const queryMatch = /<user_query>([\s\S]*?)<\/user_query>/u.exec(trimmed);
  return queryMatch ? (queryMatch[1] ?? "").trim() : trimmed;
}

function cursorVisibleAssistantText(message: Record<string, unknown>): string | null {
  const text = cursorContentText(message, "assistant").trim();
  return text.length > 0 ? text : null;
}

function cursorProviderOptions(message: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(message.providerOptions) || !isRecord(message.providerOptions.cursor)) {
    return null;
  }
  return message.providerOptions.cursor;
}

function cursorTurnId(message: Record<string, unknown>, blobId: string): string {
  const cursorOptions = cursorProviderOptions(message);
  const requestId = cursorOptions?.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : blobId;
}

function isFinalAnswerAssistant(message: Record<string, unknown>): boolean {
  return cursorProviderOptions(message)?.openaiPhase === "final_answer";
}

function cursorTurnTimestamp(createdAt: number, turnIndex: number): string {
  return new Date(createdAt + turnIndex).toISOString();
}

function finishCursorTurn(
  turns: BackendSyncedTurn[],
  current: CursorTurnBuilder,
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

function parseCursorMessageBlob(id: string, data: Buffer): CursorMessageBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `cursor store message blob "${id}" is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || typeof parsed.role !== "string") {
    throw new Error(
      `cursor store message blob "${id}" must decode to a JSON object with string role`,
    );
  }
  return { id, message: parsed };
}

function selectCursorAssistantText(params: {
  current: CursorTurnBuilder;
  message: Record<string, unknown>;
  text: string;
  assistantTimestamp: string;
}): void {
  const { current, message, text, assistantTimestamp } = params;
  const nextIsFinal = isFinalAnswerAssistant(message);
  if (nextIsFinal || !current.selectedAssistantIsFinal) {
    current.assistantText = text;
    current.selectedAssistantIsFinal = nextIsFinal;
    current.updatedAt = assistantTimestamp;
  }
}

function createCursorTurnAccumulator(createdAt: number): CursorTurnAccumulator {
  return {
    turns: [],
    current: null,
    currentTurnIndex: -1,
    createdAt,
  };
}

function applyCursorMessageToTurns(
  accumulator: CursorTurnAccumulator,
  blob: CursorMessageBlob,
): void {
  const { id, message } = blob;
  if (message.role === "user") {
    const userText = cursorVisibleUserText(message);
    if (userText === null) {
      return;
    }
    if (accumulator.current !== null && accumulator.current.assistantText.length > 0) {
      finishCursorTurn(accumulator.turns, accumulator.current, "complete");
    }
    accumulator.currentTurnIndex++;
    const timestamp = cursorTurnTimestamp(accumulator.createdAt, accumulator.currentTurnIndex);
    accumulator.current = {
      backendTurnId: cursorTurnId(message, id),
      startedAt: timestamp,
      updatedAt: timestamp,
      userText,
      assistantText: "",
      selectedAssistantIsFinal: false,
    };
    return;
  }
  if (message.role === "assistant" && accumulator.current !== null) {
    const assistantText = cursorVisibleAssistantText(message);
    if (assistantText !== null) {
      selectCursorAssistantText({
        current: accumulator.current,
        message,
        text: assistantText,
        assistantTimestamp: cursorTurnTimestamp(
          accumulator.createdAt,
          accumulator.currentTurnIndex + 1,
        ),
      });
    }
  }
}

function finishCursorTurns(
  accumulator: CursorTurnAccumulator,
  mode: "bootstrap" | "sync",
): BackendSyncedTurn[] {
  if (accumulator.current !== null) {
    if (accumulator.current.assistantText.length > 0) {
      finishCursorTurn(accumulator.turns, accumulator.current, "complete");
    } else if (mode === "sync") {
      finishCursorTurn(accumulator.turns, accumulator.current, "open");
    }
  }
  return accumulator.turns;
}

export function parseCursorSessionHistoryStore(params: {
  path: string;
  sessionId: string;
  mode: "bootstrap" | "sync";
}): BackendSyncedTurn[] {
  let db: Database.Database;
  try {
    db = openCursorStore(params.path);
  } catch (error) {
    throw new Error(
      `failed to open Cursor store ${params.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const meta = readCursorMeta(db);
    if (meta.agentId !== params.sessionId) {
      throw new Error(
        `cursor store agentId "${meta.agentId}" does not match session "${params.sessionId}"`,
      );
    }
    const readBlob = db.prepare("SELECT data FROM blobs WHERE id = ?");
    const rootBlob = readCursorBlob(readBlob, meta.latestRootBlobId);
    if (rootBlob === null) {
      throw new Error(`cursor store root blob "${meta.latestRootBlobId}" is missing`);
    }
    const orderedIds = parseCursorRootBlobMessageIds(rootBlob);
    const accumulator = createCursorTurnAccumulator(meta.createdAt);
    for (const id of orderedIds) {
      const blob = readCursorBlob(readBlob, id);
      if (blob === null) {
        throw new Error(`cursor store message blob "${id}" is missing`);
      }
      applyCursorMessageToTurns(accumulator, parseCursorMessageBlob(id, blob));
    }
    return finishCursorTurns(accumulator, params.mode);
  } finally {
    db.close();
  }
}

function findSessionId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSessionId(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  const direct =
    (typeof value.session_id === "string" && value.session_id) ||
    (typeof value.sessionId === "string" && value.sessionId) ||
    null;
  if (direct) return direct;

  for (const entry of Object.values(value)) {
    const found = findSessionId(entry);
    if (found) return found;
  }
  return null;
}

async function validateCursorSession(ctx: ValidateSessionContext): Promise<ValidateSessionResult> {
  const invalidReason = cursorSessionIdInvalidReason(ctx.sessionId);
  if (invalidReason !== null) {
    return { valid: false, reason: invalidReason };
  }
  const path = cursorStoreDbPath(ctx.cwd, ctx.sessionId);

  let db: Database.Database;
  try {
    db = openCursorStore(path);
  } catch (error) {
    return {
      valid: false,
      reason: `cursor store is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const meta = readCursorMeta(db);
    if (meta.agentId !== ctx.sessionId) {
      return {
        valid: false,
        reason: `cursor store agentId "${meta.agentId}" does not match session "${ctx.sessionId}"`,
      };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

async function resolveCursorSessionHistorySource(
  ctx: BackendSessionHistorySourceContext,
): Promise<BackendSessionHistorySourceResult> {
  const validation = await validateCursorSession({
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    env: ctx.env,
    backendConfig: ctx.backendConfig,
    resolvedBackendArgs: ctx.resolvedBackendArgs,
  });
  if (!validation.valid) {
    return { available: false, reason: validation.reason };
  }

  const path = cursorStoreDbPath(ctx.cwd, ctx.sessionId);
  if (!realFileIsUnderRoot(cursorChatsRoot(), path)) {
    return { available: false, reason: "cursor store escaped the chats root" };
  }
  return { available: true, source: sessionHistoryFileSource(path) };
}

async function readCursorSessionHistory(
  ctx: BackendSessionHistoryContext,
): Promise<BackendSessionHistoryResult> {
  if (ctx.source.kind !== "file") {
    throw new Error("cursor session history source must be a file");
  }
  const source = sessionHistoryFileSource(ctx.source.path);
  return {
    source,
    cursor: { kind: "file", size: source.size },
    turns: parseCursorSessionHistoryStore({
      path: ctx.source.path,
      sessionId: ctx.sessionId,
      mode: ctx.mode,
    }),
  };
}

export const normalizeCursorModel = normalizeBackendModel;

export function buildCursorArgs(
  ctx: Pick<
    BackendInvokeContext,
    "cwd" | "model" | "prompt" | "resolvedBackendArgs" | "resumeSessionId" | "unrestricted"
  >,
): string[] {
  const args = [
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    ctx.cwd,
  ];

  if (ctx.model) {
    args.push("--model", normalizeCursorModel(ctx.model));
  }
  if (ctx.unrestricted) {
    args.push("--force");
  }
  if (ctx.resumeSessionId) {
    args.push("--resume", ctx.resumeSessionId);
  }
  args.push(...ctx.resolvedBackendArgs);
  if (ctx.prompt.trim().length > 0) {
    args.push(ctx.prompt);
  }
  return args;
}

interface StreamState {
  sessionId: string | null;
  resultText: string | null;
  streamedText: string;
  pendingBoundary: boolean;
  parseError: Error | null;
  onText: (text: string) => void;
}

function captureSessionId(state: StreamState, event: Record<string, unknown>): void {
  if (state.sessionId) return;
  state.sessionId = findSessionId(event);
}

function parseResultText(event: Record<string, unknown>): string | null {
  if (!isRecord(event.result)) return null;
  return typeof event.result.result === "string" ? event.result.result : null;
}

function processLine(state: StreamState, line: string): void {
  if (state.parseError) return;
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  if (!trimmed.startsWith("{")) {
    state.parseError = new Error(`cursor stream-json emitted a non-JSON line: ${trimmed}`);
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch (error) {
    state.parseError = new Error(
      `cursor stream-json emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!isRecord(event)) {
    state.parseError = new Error("cursor stream-json emitted a non-object JSON record");
    return;
  }

  captureSessionId(state, event);

  if (event.type === "partial_output") {
    if (typeof event.text !== "string") {
      state.parseError = new Error("cursor partial_output record is missing string text");
      return;
    }
    const delta = event.text;
    if (state.pendingBoundary) {
      const separator = streamBoundarySeparator(state.streamedText, delta);
      if (separator.length > 0) {
        state.streamedText += separator;
        state.onText(separator);
      }
      state.pendingBoundary = false;
    }
    state.streamedText += delta;
    state.onText(delta);
    return;
  }

  if (event.type === "assistant" || event.type === "tool_call") {
    if (state.streamedText.length > 0) {
      state.pendingBoundary = true;
    }
    return;
  }

  if (event.type === "result") {
    state.resultText = parseResultText(event);
  }
}

function feed(lineFeeder: LineFeeder, chunk: string): void {
  lineFeeder.feed(chunk);
}

function flush(lineFeeder: LineFeeder): void {
  lineFeeder.flush();
}

export const cursorBackend: Backend = {
  id: "cursor",
  validateSessionId: validateCursorSession,
  resolveSessionHistorySource: resolveCursorSessionHistorySource,
  readSessionHistory: readCursorSessionHistory,
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const state: StreamState = {
      sessionId: null,
      resultText: null,
      streamedText: "",
      pendingBoundary: false,
      parseError: null,
      onText: (text) => ctx.emit?.({ type: "agent_message_delta", text }),
    };
    const lineFeeder = createLineFeeder({
      onLine: (line) => processLine(state, line),
      onPartial: (partial) => processLine(state, partial),
      onRawSegment: ctx.onRawStdoutLine,
    });

    const result = await runProcess({
      command: process.env.TASK_RUNNER_CURSOR_BIN ?? "cursor-agent",
      args: buildCursorArgs(ctx),
      launcher: ctx.launcher,
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: ctx.timeoutSec * 1000,
      abortSignal: ctx.abortSignal,
      onStdout: (chunk) => feed(lineFeeder, chunk.toString("utf8")),
      onStderr: (chunk) => ctx.emit?.({ type: "backend_notice", text: chunk.toString("utf8") }),
    });
    flush(lineFeeder);

    if (state.parseError) {
      throw state.parseError;
    }
    if (result.exitCode === 0 && state.resultText === null) {
      throw new Error(
        "cursor stream-json completed successfully without a valid final result.result string",
      );
    }

    const transcript =
      result.exitCode === 0
        ? composePersistedTranscript(state.streamedText, state.resultText)
        : state.resultText;
    const fallbackDelta = silentTranscriptFallback(state.streamedText, transcript);
    if (fallbackDelta) {
      ctx.emit?.({ type: "agent_message_delta", text: fallbackDelta });
    }

    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      sessionId: state.sessionId,
      transcript,
      rawStdout: result.stdoutText,
      rawStderr: result.stderrText,
    };
  },
};
