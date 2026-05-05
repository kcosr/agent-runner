import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type {
  Backend,
  BackendInvokeContext,
  BackendInvokeResult,
  BackendSessionHistoryContext,
  BackendSessionHistoryResult,
  BackendSessionHistorySource,
  BackendSessionHistorySourceContext,
  BackendSessionHistorySourceResult,
  BackendSyncedTurn,
  EffortLevel,
  ValidateSessionContext,
  ValidateSessionResult,
} from "../core/backends/types.js";
import { runProcess } from "../util/spawn.js";
import {
  composePersistedTranscript,
  createLineFeeder,
  isRecord,
  realFileIsUnderRoot,
  silentTranscriptFallback,
  streamBoundarySeparator,
} from "./shared.js";

interface OpenCodeStreamState {
  sessionId: string | null;
  streamedText: string;
  errorText: string | null;
  onText: (text: string) => void;
}

interface OpenCodeSessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodeHistoryToken {
  kind: "opencode-sqlite";
  path: string;
  sessionId: string;
  sessionUpdatedAt: number;
  messageCount: number;
  partCount: number;
  dbMtimeMs: number;
  dbSize: number;
}

interface OpenCodeHistorySnapshot {
  token: OpenCodeHistoryToken;
  turns: BackendSyncedTurn[];
}

function mapEffortToOpenCodeVariant(effort: EffortLevel): string | null {
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
      return "max";
    case "max":
      return "max";
  }
}

export function buildOpenCodeArgs(
  ctx: Pick<
    BackendInvokeContext,
    | "effort"
    | "model"
    | "name"
    | "prompt"
    | "resolvedBackendArgs"
    | "resumeSessionId"
    | "unrestricted"
  >,
): string[] {
  const args: string[] = ["run", "--format", "json"];
  if (ctx.model) {
    args.push("--model", ctx.model);
  }
  if (ctx.effort) {
    const variant = mapEffortToOpenCodeVariant(ctx.effort);
    if (variant !== null) {
      args.push("--variant", variant);
    }
  }
  if (ctx.resumeSessionId) {
    args.push("--session", ctx.resumeSessionId);
  }
  if (ctx.name) {
    args.push("--title", ctx.name);
  }
  if (ctx.unrestricted) {
    args.push("--dangerously-skip-permissions");
  }
  args.push(...ctx.resolvedBackendArgs);
  if (ctx.prompt.trim().length > 0) {
    args.push(ctx.prompt);
  }
  return args;
}

function captureSessionId(state: OpenCodeStreamState, event: Record<string, unknown>): void {
  if (state.sessionId !== null) return;
  const direct =
    (typeof event.sessionID === "string" && event.sessionID) ||
    (typeof event.sessionId === "string" && event.sessionId) ||
    (typeof event.session_id === "string" && event.session_id) ||
    null;
  if (direct !== null) {
    state.sessionId = direct;
    return;
  }
  const part = event.part;
  if (isRecord(part) && typeof part.sessionID === "string" && part.sessionID.length > 0) {
    state.sessionId = part.sessionID;
  }
}

function extractOpenCodeError(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return null;
  if (typeof error.message === "string") return error.message;
  const data = error.data;
  if (isRecord(data) && typeof data.message === "string") return data.message;
  return JSON.stringify(error);
}

function emitOpenCodeText(state: OpenCodeStreamState, text: string): void {
  if (text.length === 0) return;
  const separator = streamBoundarySeparator(state.streamedText, text);
  const delta = `${separator}${text}`;
  state.streamedText += delta;
  state.onText(delta);
}

function processOpenCodeLine(state: OpenCodeStreamState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;

  captureSessionId(state, parsed);

  if (parsed.type === "text" && isRecord(parsed.part) && typeof parsed.part.text === "string") {
    emitOpenCodeText(state, parsed.part.text);
    return;
  }

  if (parsed.type === "error") {
    const errorText = extractOpenCodeError(parsed.error);
    if (errorText !== null) {
      state.errorText = state.errorText === null ? errorText : `${state.errorText}\n${errorText}`;
    }
  }
}

function homeFromEnv(env: Record<string, string>): string {
  return env.HOME?.trim() || homedir();
}

export function opencodeDataDir(
  env: Record<string, string> = process.env as Record<string, string>,
): string {
  const explicit = env.TASK_RUNNER_OPENCODE_DATA_DIR?.trim() || env.OPENCODE_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const xdgData = env.XDG_DATA_HOME?.trim() || join(homeFromEnv(env), ".local", "share");
  return resolve(xdgData, "opencode");
}

export function opencodeDbPath(
  env: Record<string, string> = process.env as Record<string, string>,
): string {
  return join(opencodeDataDir(env), "opencode.db");
}

function validateOpenCodeSessionId(sessionId: string): string | null {
  if (sessionId.trim().length === 0) {
    return "opencode session id cannot be empty";
  }
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    return "opencode session id must be a session id, not a path";
  }
  return null;
}

function unquoteOpenCodeStoredPrompt(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function openOpenCodeDb(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true, timeout: 30_000 });
}

function getOpenCodeSessionRow(
  db: Database.Database,
  sessionId: string,
): OpenCodeSessionRow | null {
  const row = db
    .prepare("SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?")
    .get(sessionId);
  if (!isRecord(row)) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.directory !== "string" ||
    typeof row.title !== "string" ||
    typeof row.time_created !== "number" ||
    typeof row.time_updated !== "number"
  ) {
    throw new Error(`opencode session row for "${sessionId}" is malformed`);
  }
  return row as unknown as OpenCodeSessionRow;
}

type ResolvedOpenCodeSession =
  | { ok: true; dbPath: string; dataDir: string; row: OpenCodeSessionRow }
  | { ok: false; reason: string; transient?: boolean };

function isSqliteBusyError(error: unknown): boolean {
  if (isRecord(error) && error.code === "SQLITE_BUSY") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SQLITE_BUSY") || message.includes("database is locked");
}

function sqliteBusyError(error: unknown): Error & { transient: true } {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`opencode database is currently busy: ${message}`), {
    transient: true as const,
  });
}

function resolveOpenCodeSession(
  cwd: string,
  sessionId: string,
  env: Record<string, string>,
): ResolvedOpenCodeSession {
  const invalidReason = validateOpenCodeSessionId(sessionId);
  if (invalidReason !== null) {
    return { ok: false, reason: invalidReason };
  }
  const dataDir = opencodeDataDir(env);
  const path = opencodeDbPath(env);
  if (!existsSync(path)) {
    return { ok: false, reason: `opencode database not found: ${path}` };
  }
  if (!realFileIsUnderRoot(dataDir, path)) {
    return { ok: false, reason: "opencode database escaped the data directory" };
  }

  let db: Database.Database;
  try {
    db = openOpenCodeDb(path);
  } catch (error) {
    const reason = `opencode database is unreadable: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      ok: false,
      reason,
      ...(isSqliteBusyError(error) ? { transient: true } : {}),
    };
  }
  try {
    let row: OpenCodeSessionRow | null;
    try {
      row = getOpenCodeSessionRow(db, sessionId);
    } catch (error) {
      if (isSqliteBusyError(error)) {
        return {
          ok: false,
          reason: `opencode database is currently busy: ${
            error instanceof Error ? error.message : String(error)
          }`,
          transient: true,
        };
      }
      return {
        ok: false,
        reason: `opencode database is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (row === null) {
      return { ok: false, reason: `opencode session "${sessionId}" not found` };
    }
    if (row.directory !== cwd) {
      return {
        ok: false,
        reason: `opencode session "${sessionId}" belongs to cwd "${row.directory}", not "${cwd}"`,
      };
    }
    return { ok: true, dbPath: path, dataDir, row };
  } finally {
    db.close();
  }
}

async function validateOpenCodeSession(
  ctx: ValidateSessionContext,
): Promise<ValidateSessionResult> {
  const resolved = resolveOpenCodeSession(
    ctx.cwd,
    ctx.sessionId,
    ctx.env ?? (process.env as Record<string, string>),
  );
  return resolved.ok ? { valid: true } : { valid: false, reason: resolved.reason };
}

function countValue(row: unknown, key: string): number {
  if (!isRecord(row) || typeof row[key] !== "number") {
    throw new Error(`opencode history count query did not return numeric ${key}`);
  }
  return row[key];
}

function openCodeHistoryToken(params: {
  db: Database.Database;
  dbPath: string;
  sessionId: string;
  sessionUpdatedAt: number;
}): OpenCodeHistoryToken {
  const messageCount = countValue(
    params.db
      .prepare("SELECT count(*) AS count FROM message WHERE session_id = ?")
      .get(params.sessionId),
    "count",
  );
  const partCount = countValue(
    params.db
      .prepare("SELECT count(*) AS count FROM part WHERE session_id = ?")
      .get(params.sessionId),
    "count",
  );
  const stats = statSync(params.dbPath);
  return {
    kind: "opencode-sqlite",
    path: params.dbPath,
    sessionId: params.sessionId,
    sessionUpdatedAt: params.sessionUpdatedAt,
    messageCount,
    partCount,
    dbMtimeMs: stats.mtimeMs,
    dbSize: stats.size,
  };
}

function opencodeSessionHistorySource(token: OpenCodeHistoryToken): BackendSessionHistorySource {
  return {
    kind: "custom",
    label: token.path,
    changeToken: token,
  };
}

function opencodeSourcePath(source: BackendSessionHistorySource): string {
  if (
    source.kind !== "custom" ||
    !isRecord(source.changeToken) ||
    source.changeToken.kind !== "opencode-sqlite" ||
    typeof source.changeToken.path !== "string"
  ) {
    throw new Error("opencode session history source must be an opencode sqlite source");
  }
  return source.changeToken.path;
}

async function resolveOpenCodeSessionHistorySource(
  ctx: BackendSessionHistorySourceContext,
): Promise<BackendSessionHistorySourceResult> {
  const resolved = resolveOpenCodeSession(ctx.cwd, ctx.sessionId, ctx.env);
  if (!resolved.ok) {
    return {
      available: false,
      reason: resolved.reason,
      ...(resolved.transient === true ? { transient: true } : {}),
    };
  }
  let db: Database.Database;
  try {
    db = openOpenCodeDb(resolved.dbPath);
  } catch (error) {
    return {
      available: false,
      reason: `opencode database is unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      ...(isSqliteBusyError(error) ? { transient: true } : {}),
    };
  }
  try {
    let token: OpenCodeHistoryToken;
    try {
      token = openCodeHistoryToken({
        db,
        dbPath: resolved.dbPath,
        sessionId: ctx.sessionId,
        sessionUpdatedAt: resolved.row.time_updated,
      });
    } catch (error) {
      if (isSqliteBusyError(error)) {
        return {
          available: false,
          reason: `opencode database is currently busy: ${
            error instanceof Error ? error.message : String(error)
          }`,
          transient: true,
        };
      }
      throw error;
    }
    return { available: true, source: opencodeSessionHistorySource(token) };
  } finally {
    db.close();
  }
}

function parseJsonData(row: { id: string; data: string }, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("data is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `failed to parse opencode ${label} ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function timestampFromMs(value: unknown, fallback: number): string {
  return new Date(
    typeof value === "number" && Number.isFinite(value) ? value : fallback,
  ).toISOString();
}

function timestampNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function textFromParts(parts: OpenCodePartRow[], role: "user" | "assistant"): string {
  let text = "";
  for (const partRow of parts) {
    const part = parseJsonData(partRow, "part");
    if (part.type !== "text") continue;
    if (role === "user" && part.ignored === true) continue;
    if (typeof part.text === "string") {
      text += part.text;
    }
  }
  return text.trim();
}

function partEndTime(parts: OpenCodePartRow[]): number | null {
  let latest: number | null = null;
  for (const partRow of parts) {
    const part = parseJsonData(partRow, "part");
    const time = isRecord(part.time) ? part.time : null;
    const end = time && typeof time.end === "number" && Number.isFinite(time.end) ? time.end : null;
    latest = end === null ? latest : Math.max(latest ?? end, end);
  }
  return latest;
}

interface OpenCodeTurnBuilder {
  backendTurnId: string;
  userMessageId: string;
  startedAt: string;
  updatedAt: string;
  userText: string;
  assistantText: string;
  assistantSeen: boolean;
  assistantCompleted: boolean;
}

function pushOpenCodeTurn(
  turns: BackendSyncedTurn[],
  current: OpenCodeTurnBuilder,
  mode: "bootstrap" | "sync",
  forceComplete: boolean,
): void {
  if (mode === "bootstrap") {
    if (!current.assistantSeen && current.assistantText.length === 0) {
      return;
    }
    turns.push({
      backendTurnId: current.backendTurnId,
      status: "complete",
      startedAt: current.startedAt,
      updatedAt: current.updatedAt,
      userText: current.userText,
      assistantText: current.assistantText.length > 0 ? current.assistantText : null,
    });
    return;
  }

  const complete = forceComplete || current.assistantCompleted;
  turns.push({
    backendTurnId: current.backendTurnId,
    status: complete ? "complete" : "open",
    startedAt: current.startedAt,
    updatedAt: current.updatedAt,
    userText: current.userText,
    assistantText: current.assistantText.length > 0 ? current.assistantText : null,
  });
}

function parseOpenCodeSessionHistoryRows(params: {
  messages: OpenCodeMessageRow[];
  partsByMessage: Map<string, OpenCodePartRow[]>;
  mode: "bootstrap" | "sync";
}): BackendSyncedTurn[] {
  const turns: BackendSyncedTurn[] = [];
  let current: OpenCodeTurnBuilder | null = null;

  for (const row of params.messages) {
    const message = parseJsonData(row, "message");
    const role = message.role;
    const parts = params.partsByMessage.get(row.id) ?? [];
    if (role === "user") {
      if (current !== null) {
        pushOpenCodeTurn(turns, current, params.mode, true);
      }
      const userText = textFromParts(parts, "user");
      if (userText.length === 0) {
        current = null;
        continue;
      }
      const time = isRecord(message.time) ? message.time : null;
      const startedMs = timestampNumber(time?.created, row.time_created);
      current = {
        backendTurnId: row.id,
        userMessageId: row.id,
        startedAt: new Date(startedMs).toISOString(),
        updatedAt: new Date(startedMs).toISOString(),
        userText,
        assistantText: "",
        assistantSeen: false,
        assistantCompleted: false,
      };
      continue;
    }

    if (role !== "assistant" || current === null) continue;
    if (typeof message.parentID === "string" && message.parentID !== current.userMessageId) {
      continue;
    }
    current.assistantSeen = true;
    const assistantText = textFromParts(parts, "assistant");
    if (assistantText.length > 0) {
      const separator = streamBoundarySeparator(current.assistantText, assistantText);
      current.assistantText += `${separator}${assistantText}`;
    }
    const time = isRecord(message.time) ? message.time : null;
    const completedAt = timestampNumber(time?.completed, row.time_updated);
    const latestPartEnd = partEndTime(parts);
    current.updatedAt = timestampFromMs(latestPartEnd ?? time?.completed, completedAt);
    if (typeof time?.completed === "number" || typeof message.finish === "string") {
      current.assistantCompleted = true;
    }
  }

  if (current !== null) {
    pushOpenCodeTurn(turns, current, params.mode, false);
  }
  return turns;
}

export function parseOpenCodeSessionHistorySnapshot(params: {
  db: Database.Database;
  dbPath: string;
  sessionId: string;
  mode: "bootstrap" | "sync";
}): OpenCodeHistorySnapshot {
  const session = getOpenCodeSessionRow(params.db, params.sessionId);
  if (session === null) {
    throw new Error(`opencode session "${params.sessionId}" not found`);
  }
  const messages = params.db
    .prepare(
      "SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    )
    .all(params.sessionId) as OpenCodeMessageRow[];
  const parts = params.db
    .prepare(
      "SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY message_id, id",
    )
    .all(params.sessionId) as OpenCodePartRow[];
  const partsByMessage = new Map<string, OpenCodePartRow[]>();
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id);
    if (list) list.push(part);
    else partsByMessage.set(part.message_id, [part]);
  }
  const token = openCodeHistoryToken({
    db: params.db,
    dbPath: params.dbPath,
    sessionId: params.sessionId,
    sessionUpdatedAt: session.time_updated,
  });
  return {
    token,
    turns: parseOpenCodeSessionHistoryRows({
      messages,
      partsByMessage,
      mode: params.mode,
    }),
  };
}

async function readOpenCodeSessionHistory(
  ctx: BackendSessionHistoryContext,
): Promise<BackendSessionHistoryResult> {
  const path = opencodeSourcePath(ctx.source);
  const dataDir = opencodeDataDir(ctx.env);
  if (!realFileIsUnderRoot(dataDir, path)) {
    throw new Error("opencode database escaped the data directory");
  }
  let db: Database.Database;
  try {
    db = openOpenCodeDb(path);
  } catch (error) {
    if (isSqliteBusyError(error)) {
      throw sqliteBusyError(error);
    }
    throw error;
  }
  try {
    let snapshot: OpenCodeHistorySnapshot;
    try {
      snapshot = parseOpenCodeSessionHistorySnapshot({
        db,
        dbPath: path,
        sessionId: ctx.sessionId,
        mode: ctx.mode,
      });
    } catch (error) {
      if (isSqliteBusyError(error)) {
        throw sqliteBusyError(error);
      }
      throw error;
    }
    const source = opencodeSessionHistorySource(snapshot.token);
    return {
      source,
      cursor: {
        kind: "opencode-sqlite",
        sessionUpdatedAt: snapshot.token.sessionUpdatedAt,
        messageCount: snapshot.token.messageCount,
        partCount: snapshot.token.partCount,
      },
      turns: snapshot.turns,
    };
  } finally {
    db.close();
  }
}

export const opencodeBackend: Backend = {
  id: "opencode",
  validateSessionId: validateOpenCodeSession,
  resolveSessionHistorySource: resolveOpenCodeSessionHistorySource,
  readSessionHistory: readOpenCodeSessionHistory,
  taskRunnerPromptMatchesSyncedTurn: ({ prompt, turn }) =>
    prompt === unquoteOpenCodeStoredPrompt(turn.userText ?? ""),
  async invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult> {
    const args = buildOpenCodeArgs(ctx);
    const state: OpenCodeStreamState = {
      sessionId: null,
      streamedText: "",
      errorText: null,
      onText: (text) => ctx.emit?.({ type: "agent_message_delta", text }),
    };
    const lineFeeder = createLineFeeder({
      onLine: (line) => processOpenCodeLine(state, line),
      onPartial: (partial) => processOpenCodeLine(state, partial),
      onRawSegment: ctx.onRawStdoutLine,
    });

    const result = await runProcess({
      command: ctx.env.TASK_RUNNER_OPENCODE_BIN ?? "opencode",
      args,
      launcher: ctx.launcher,
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: ctx.timeoutSec * 1000,
      abortSignal: ctx.abortSignal,
      onStdout: (chunk) => lineFeeder.feed(chunk.toString("utf8")),
      onStderr: (chunk) => ctx.emit?.({ type: "backend_notice", text: chunk.toString("utf8") }),
    });
    lineFeeder.flush();

    if (state.errorText !== null) {
      ctx.emit?.({ type: "backend_notice", text: state.errorText });
    }
    const transcript = composePersistedTranscript(state.streamedText, null);
    const fallbackDelta = silentTranscriptFallback(state.streamedText, transcript);
    if (fallbackDelta) {
      ctx.emit?.({ type: "agent_message_delta", text: fallbackDelta });
    }

    return {
      exitCode: state.errorText !== null && result.exitCode === 0 ? 1 : result.exitCode,
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
