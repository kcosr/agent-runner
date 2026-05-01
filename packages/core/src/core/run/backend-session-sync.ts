import { rmSync } from "node:fs";
import type {
  Backend,
  BackendSessionHistoryResult,
  BackendSessionHistorySource,
  BackendSyncedTurn,
} from "../backends/types.js";
import {
  cloneBackendConfig,
  cloneResolvedBackendArgs,
  isJsonishPersistable,
} from "../backends/types.js";
import type {
  AttemptRecord,
  BackendSessionSyncState,
  RunHistoryProvenance,
  RunManifest,
  SessionRecord,
} from "./manifest.js";
import {
  cloneBackendSessionHistorySource,
  cloneBackendSessionSyncState,
  writeAttemptLog,
} from "./manifest.js";

export type BackendSessionHistorySyncMode = "bootstrap" | "sync";

export type BackendSessionHistorySyncResult =
  | {
      status: "skipped";
      reason: "no_backend_session" | "unsupported" | "source_unavailable" | "unchanged";
      changed: false;
      source: BackendSessionHistorySource | null;
      importedTurnCount: number;
      openTurnCount: number;
    }
  | {
      status: "synced";
      changed: boolean;
      source: BackendSessionHistorySource;
      importedTurnCount: number;
      openTurnCount: number;
      addedAttemptNumbers: number[];
    };

export interface BackendSessionHistorySyncOptions {
  manifest: RunManifest;
  backend: Backend;
  mode: BackendSessionHistorySyncMode;
  env?: Record<string, string>;
}

export class BackendSessionHistorySyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendSessionHistorySyncError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sourcesMatch(
  left: BackendSessionHistorySource | null,
  right: BackendSessionHistorySource,
): boolean {
  return left !== null && stableJson(left.changeToken) === stableJson(right.changeToken);
}

function cloneSource(source: BackendSessionHistorySource): BackendSessionHistorySource {
  return cloneBackendSessionHistorySource(source);
}

function validateBackendTurn(turn: BackendSyncedTurn, index: number): void {
  if (typeof turn.backendTurnId !== "string" || turn.backendTurnId.length === 0) {
    throw new BackendSessionHistorySyncError(`backend history turn #${index + 1} has no id`);
  }
  if (turn.status !== "complete" && turn.status !== "open") {
    throw new BackendSessionHistorySyncError(
      `backend history turn ${turn.backendTurnId} has invalid status`,
    );
  }
  if (typeof turn.startedAt !== "string" || Number.isNaN(new Date(turn.startedAt).getTime())) {
    throw new BackendSessionHistorySyncError(
      `backend history turn ${turn.backendTurnId} has invalid startedAt`,
    );
  }
  if (typeof turn.updatedAt !== "string" || Number.isNaN(new Date(turn.updatedAt).getTime())) {
    throw new BackendSessionHistorySyncError(
      `backend history turn ${turn.backendTurnId} has invalid updatedAt`,
    );
  }
  if (turn.userText !== null && typeof turn.userText !== "string") {
    throw new BackendSessionHistorySyncError(
      `backend history turn ${turn.backendTurnId} has invalid user text`,
    );
  }
  if (turn.assistantText !== null && typeof turn.assistantText !== "string") {
    throw new BackendSessionHistorySyncError(
      `backend history turn ${turn.backendTurnId} has invalid assistant text`,
    );
  }
}

function validateHistoryResult(result: BackendSessionHistoryResult): void {
  if (!isJsonishPersistable(result.cursor)) {
    throw new BackendSessionHistorySyncError("backend history cursor is not JSON-persistable");
  }
  if (!isJsonishPersistable(result.source.changeToken)) {
    throw new BackendSessionHistorySyncError(
      "backend history source change token is not JSON-persistable",
    );
  }
  result.turns.forEach(validateBackendTurn);
}

function buildProvenance(params: {
  manifest: RunManifest;
  backendSessionId: string;
  turn: BackendSyncedTurn;
  importedAt: string;
  lastSyncedAt: string;
  mode: BackendSessionHistorySyncMode;
  source: BackendSessionHistorySource;
}): RunHistoryProvenance {
  return {
    kind: "backend_session",
    backend: params.manifest.backend,
    backendSessionId: params.backendSessionId,
    backendTurnId: params.turn.backendTurnId,
    importedAt: params.importedAt,
    lastSyncedAt: params.lastSyncedAt,
    mode: params.mode,
    source: cloneSource(params.source),
  };
}

function backendSessionTurnId(record: AttemptRecord | SessionRecord): string | null {
  return record.provenance.kind === "backend_session" ? record.provenance.backendTurnId : null;
}

function isBackendSessionAttempt(
  manifest: RunManifest,
  backendSessionId: string,
  turn: BackendSyncedTurn,
  record: AttemptRecord,
): boolean {
  return (
    record.provenance.kind === "backend_session" &&
    record.provenance.backend === manifest.backend &&
    record.provenance.backendSessionId === backendSessionId &&
    record.provenance.backendTurnId === turn.backendTurnId
  );
}

function taskRunnerAttemptMatchesBackendTurn(
  manifest: RunManifest,
  backendSessionId: string,
  turn: BackendSyncedTurn,
  record: AttemptRecord,
): boolean {
  if (record.provenance.kind !== "task_runner") {
    return false;
  }
  const session = manifest.sessions.find(
    (candidate) => candidate.sessionIndex === record.sessionIndex,
  );
  const attemptMatches =
    record.sessionIdAtStart === backendSessionId || record.sessionIdCaptured === backendSessionId;
  const sessionMatches =
    session !== undefined &&
    (session.backendSessionIdAtStart === backendSessionId ||
      session.backendSessionIdAtEnd === backendSessionId);
  if (!attemptMatches && !sessionMatches) {
    return false;
  }
  if (record.prompt !== (turn.userText ?? "")) {
    return false;
  }
  const turnStartedAt = Date.parse(turn.startedAt);
  const turnUpdatedAt = Date.parse(turn.updatedAt);
  const recordStartedAt = Date.parse(record.startedAt);
  const recordEndedAt = record.endedAt === null ? recordStartedAt : Date.parse(record.endedAt);
  return recordStartedAt <= turnUpdatedAt && recordEndedAt >= turnStartedAt;
}

function findExistingAttempt(
  manifest: RunManifest,
  backendSessionId: string,
  turn: BackendSyncedTurn,
): AttemptRecord | undefined {
  return (
    manifest.attemptRecords.find((record) =>
      isBackendSessionAttempt(manifest, backendSessionId, turn, record),
    ) ??
    manifest.attemptRecords.find((record) =>
      taskRunnerAttemptMatchesBackendTurn(manifest, backendSessionId, turn, record),
    )
  );
}

function findExistingSession(
  manifest: RunManifest,
  backendSessionId: string,
  turn: BackendSyncedTurn,
): SessionRecord | undefined {
  return manifest.sessions.find(
    (record) =>
      record.provenance.kind === "backend_session" &&
      record.provenance.backend === manifest.backend &&
      record.provenance.backendSessionId === backendSessionId &&
      record.provenance.backendTurnId === turn.backendTurnId,
  );
}

function nextAttemptNumber(manifest: RunManifest): number {
  const highest = manifest.attemptRecords.reduce(
    (max, record) => Math.max(max, record.attemptNumber),
    0,
  );
  return highest + 1;
}

function nextSessionIndex(manifest: RunManifest): number {
  const highest = manifest.sessions.reduce((max, record) => Math.max(max, record.sessionIndex), -1);
  return highest + 1;
}

function writeImportedAttemptLog(params: {
  manifest: RunManifest;
  sessionIndex: number;
  attemptNumber: number;
  turn: BackendSyncedTurn;
}): string {
  return writeAttemptLog(params.manifest.workspaceDir, {
    schemaVersion: 3,
    runId: params.manifest.runId,
    attemptNumber: params.attemptNumber,
    sessionIndex: params.sessionIndex,
    attemptIndexInSession: 0,
    startedAt: params.turn.startedAt,
    endedAt: params.turn.updatedAt,
    stderr: "",
  });
}

function existingCompleteTurnMatches(params: {
  attempt: AttemptRecord;
  session: SessionRecord;
  backendSessionId: string;
  turn: BackendSyncedTurn;
}): boolean {
  const { attempt, session, backendSessionId, turn } = params;
  return (
    attempt.startedAt === turn.startedAt &&
    attempt.endedAt === turn.updatedAt &&
    attempt.prompt === (turn.userText ?? "") &&
    attempt.transcript === turn.assistantText &&
    attempt.sessionIdAtStart === backendSessionId &&
    attempt.sessionIdCaptured === backendSessionId &&
    session.startedAt === turn.startedAt &&
    session.endedAt === turn.updatedAt &&
    session.message === turn.userText &&
    session.brief === (turn.userText ?? "") &&
    session.backendSessionIdAtStart === backendSessionId &&
    session.backendSessionIdAtEnd === backendSessionId
  );
}

function upsertCompleteTurn(params: {
  manifest: RunManifest;
  backendSessionId: string;
  turn: BackendSyncedTurn;
  mode: BackendSessionHistorySyncMode;
  source: BackendSessionHistorySource;
  syncedAt: string;
}): { changed: boolean; addedAttemptNumber: number | null; createdLogPath: string | null } {
  const { manifest, backendSessionId, turn, mode, source, syncedAt } = params;
  const existingAttempt = findExistingAttempt(manifest, backendSessionId, turn);
  const existingSession =
    findExistingSession(manifest, backendSessionId, turn) ??
    (existingAttempt
      ? manifest.sessions.find((record) => record.sessionIndex === existingAttempt.sessionIndex)
      : undefined);
  if (existingAttempt && existingSession) {
    if (
      existingCompleteTurnMatches({
        attempt: existingAttempt,
        session: existingSession,
        backendSessionId,
        turn,
      })
    ) {
      return { changed: false, addedAttemptNumber: null, createdLogPath: null };
    }
    const importedAt =
      existingAttempt.provenance.kind === "backend_session"
        ? existingAttempt.provenance.importedAt
        : syncedAt;
    const provenance = buildProvenance({
      manifest,
      backendSessionId,
      turn,
      importedAt,
      lastSyncedAt: syncedAt,
      mode,
      source,
    });
    existingAttempt.startedAt = turn.startedAt;
    existingAttempt.endedAt = turn.updatedAt;
    existingAttempt.prompt = turn.userText ?? "";
    existingAttempt.transcript = turn.assistantText;
    existingAttempt.logPath = writeImportedAttemptLog({
      manifest,
      sessionIndex: existingAttempt.sessionIndex,
      attemptNumber: existingAttempt.attemptNumber,
      turn,
    });
    existingAttempt.provenance = provenance;
    existingSession.startedAt = turn.startedAt;
    existingSession.endedAt = turn.updatedAt;
    existingSession.message = turn.userText;
    existingSession.brief = turn.userText ?? "";
    existingSession.backendSessionIdAtStart = backendSessionId;
    existingSession.backendSessionIdAtEnd = backendSessionId;
    existingSession.provenance = provenance;
    return { changed: true, addedAttemptNumber: null, createdLogPath: null };
  }

  const sessionIndex = nextSessionIndex(manifest);
  const attemptNumber = nextAttemptNumber(manifest);
  const provenance = buildProvenance({
    manifest,
    backendSessionId,
    turn,
    importedAt: syncedAt,
    lastSyncedAt: syncedAt,
    mode,
    source,
  });
  const logPath = writeImportedAttemptLog({ manifest, sessionIndex, attemptNumber, turn });
  const session: SessionRecord = {
    sessionIndex,
    startedAt: turn.startedAt,
    endedAt: turn.updatedAt,
    status: "success",
    exitCode: 0,
    message: turn.userText,
    brief: turn.userText ?? "",
    firstAttemptNumber: attemptNumber,
    lastAttemptNumber: attemptNumber,
    maxAttemptsPerSession: 1,
    backendSessionIdAtStart: backendSessionId,
    backendSessionIdAtEnd: backendSessionId,
    provenance,
  };
  const attempt: AttemptRecord = {
    attemptNumber,
    sessionIndex,
    attemptIndexInSession: 0,
    startedAt: turn.startedAt,
    endedAt: turn.updatedAt,
    prompt: turn.userText ?? "",
    sessionIdAtStart: backendSessionId,
    sessionIdCaptured: backendSessionId,
    exitCode: 0,
    signal: null,
    timedOut: false,
    transcript: turn.assistantText,
    logPath,
    invalidStatuses: [],
    provenance,
  };
  manifest.sessions.push(session);
  manifest.attemptRecords.push(attempt);
  return { changed: true, addedAttemptNumber: attemptNumber, createdLogPath: logPath };
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function buildSyncState(params: {
  manifest: RunManifest;
  backendSessionId: string;
  result: BackendSessionHistoryResult;
  syncedAt: string;
  importedTurnIds: string[];
  openTurnIds: string[];
  lastError: string | null;
}): BackendSessionSyncState {
  return {
    backend: params.manifest.backend,
    backendSessionId: params.backendSessionId,
    source: cloneSource(params.result.source),
    cursor: structuredClone(params.result.cursor),
    lastSyncedAt: params.syncedAt,
    lastError: params.lastError,
    importedTurnIds: dedupeStrings(params.importedTurnIds),
    openTurnIds: dedupeStrings(params.openTurnIds),
  };
}

async function syncBackendSessionHistoryInternal(
  options: BackendSessionHistorySyncOptions,
): Promise<BackendSessionHistorySyncResult> {
  const { manifest, backend, mode } = options;
  if (manifest.backendSessionId === null) {
    return {
      status: "skipped",
      reason: "no_backend_session",
      changed: false,
      source: null,
      importedTurnCount: 0,
      openTurnCount: 0,
    };
  }
  const backendSessionId = manifest.backendSessionId;
  if (!backend.resolveSessionHistorySource || !backend.readSessionHistory) {
    return {
      status: "skipped",
      reason: "unsupported",
      changed: false,
      source: null,
      importedTurnCount: 0,
      openTurnCount: 0,
    };
  }

  const env = options.env ?? (process.env as Record<string, string>);
  const previousState = cloneBackendSessionSyncState(manifest.backendSessionSync);
  const sourceResult = await backend.resolveSessionHistorySource({
    sessionId: backendSessionId,
    cwd: manifest.cwd,
    env,
    backendConfig: cloneBackendConfig(manifest.backendConfig),
    resolvedBackendArgs: cloneResolvedBackendArgs(manifest.resolvedBackendArgs),
    previousSource: previousState?.source ?? null,
  });
  if (!sourceResult.available) {
    return {
      status: "skipped",
      reason: "source_unavailable",
      changed: false,
      source: null,
      importedTurnCount: previousState?.importedTurnIds.length ?? 0,
      openTurnCount: previousState?.openTurnIds.length ?? 0,
    };
  }
  if (
    mode === "sync" &&
    previousState !== null &&
    sourcesMatch(previousState.source, sourceResult.source) &&
    previousState.lastError === null
  ) {
    return {
      status: "skipped",
      reason: "unchanged",
      changed: false,
      source: cloneSource(sourceResult.source),
      importedTurnCount: previousState.importedTurnIds.length,
      openTurnCount: previousState.openTurnIds.length,
    };
  }

  const historyResult = await backend.readSessionHistory({
    sessionId: backendSessionId,
    cwd: manifest.cwd,
    env,
    backendConfig: cloneBackendConfig(manifest.backendConfig),
    resolvedBackendArgs: cloneResolvedBackendArgs(manifest.resolvedBackendArgs),
    source: sourceResult.source,
    cursor: previousState?.cursor,
    mode,
  });
  validateHistoryResult(historyResult);

  const completeTurns = historyResult.turns.filter((turn) => turn.status === "complete");
  const openTurns = historyResult.turns.filter((turn) => turn.status === "open");
  const syncedAt = new Date().toISOString();
  const addedAttemptNumbers: number[] = [];
  const createdLogPaths: string[] = [];
  let changed = false;
  const snapshot = structuredClone(manifest);

  try {
    for (const turn of completeTurns) {
      const upsert = upsertCompleteTurn({
        manifest,
        backendSessionId,
        turn,
        mode,
        source: historyResult.source,
        syncedAt,
      });
      changed = upsert.changed || changed;
      if (upsert.addedAttemptNumber !== null) {
        addedAttemptNumbers.push(upsert.addedAttemptNumber);
      }
      if (upsert.createdLogPath !== null) {
        createdLogPaths.push(upsert.createdLogPath);
      }
    }

    const importedTurnIds = [
      ...manifest.attemptRecords
        .map(backendSessionTurnId)
        .filter((turnId): turnId is string => turnId !== null),
      ...completeTurns.map((turn) => turn.backendTurnId),
    ];
    manifest.backendSessionSync = buildSyncState({
      manifest,
      backendSessionId,
      result: historyResult,
      syncedAt,
      importedTurnIds,
      openTurnIds: openTurns.map((turn) => turn.backendTurnId),
      lastError: null,
    });
    manifest.totalAttemptCount = manifest.attemptRecords.length;
    manifest.totalSessionCount = manifest.sessions.length;
  } catch (error) {
    Object.assign(manifest, snapshot);
    for (const logPath of createdLogPaths) {
      rmSync(`${manifest.workspaceDir}/${logPath}`, { force: true });
    }
    throw error;
  }

  return {
    status: "synced",
    changed: changed || openTurns.length > 0,
    source: cloneSource(historyResult.source),
    importedTurnCount: completeTurns.length,
    openTurnCount: openTurns.length,
    addedAttemptNumbers,
  };
}

export async function importBackendSessionHistoryForInitialManifest(
  options: Omit<BackendSessionHistorySyncOptions, "mode">,
): Promise<BackendSessionHistorySyncResult> {
  return await syncBackendSessionHistory({ ...options, mode: "bootstrap" });
}

export async function syncBackendSessionHistory(
  options: BackendSessionHistorySyncOptions,
): Promise<BackendSessionHistorySyncResult> {
  try {
    return await syncBackendSessionHistoryInternal(options);
  } catch (error) {
    const syncError =
      error instanceof BackendSessionHistorySyncError
        ? error
        : new BackendSessionHistorySyncError(errorMessage(error), { cause: error });
    recordBackendSessionSyncError(options.manifest, syncError.message);
    throw syncError;
  }
}

export function recordBackendSessionSyncError(manifest: RunManifest, message: string): boolean {
  const previousState = manifest.backendSessionSync;
  if (
    previousState === null ||
    manifest.backendSessionId === null ||
    previousState.backend !== manifest.backend ||
    previousState.backendSessionId !== manifest.backendSessionId
  ) {
    return false;
  }
  manifest.backendSessionSync = {
    backend: previousState.backend,
    backendSessionId: previousState.backendSessionId,
    source: previousState.source === null ? null : cloneSource(previousState.source),
    cursor: structuredClone(previousState.cursor),
    lastSyncedAt: previousState.lastSyncedAt,
    lastError: message,
    importedTurnIds: [...previousState.importedTurnIds],
    openTurnIds: [...previousState.openTurnIds],
  };
  return true;
}
