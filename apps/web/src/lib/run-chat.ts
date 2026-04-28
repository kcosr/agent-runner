import type { RunTimelineAttempt, RunTimelineHistory } from "@task-runner/core/contracts/events.js";
import type { RunDetail, RunSessionSummary } from "@task-runner/core/contracts/runs.js";

export type RunChatAssistantEmptyState = "waiting_live_response" | "no_response_recorded";

export interface RunChatUserRow {
  id: string;
  kind: "user";
  sessionIndex: number;
  source: "initial" | "resume";
  text: string;
}

export interface RunChatRetryAttempt {
  attemptNumber: number;
  attemptIndexInSession: number;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  timedOut: boolean;
  live: boolean;
  transcript: string;
  emptyState?: RunChatAssistantEmptyState;
}

export interface RunChatAssistantRow extends RunChatRetryAttempt {
  id: string;
  kind: "assistant";
  sessionIndex: number;
  retryAttempts: RunChatRetryAttempt[];
}

export type RunChatRow = RunChatUserRow | RunChatAssistantRow;

function normalizedMessage(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function attemptEmptyState(attempt: RunTimelineAttempt): RunChatAssistantEmptyState | undefined {
  if (attempt.transcript.trim().length > 0) {
    return undefined;
  }
  return attempt.live ? "waiting_live_response" : "no_response_recorded";
}

function toRetryAttempt(attempt: RunTimelineAttempt): RunChatRetryAttempt {
  return {
    attemptNumber: attempt.attemptNumber,
    attemptIndexInSession: attempt.attemptIndexInSession,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    exitCode: attempt.exitCode,
    timedOut: attempt.timedOut,
    live: attempt.live,
    transcript: attempt.transcript,
    emptyState: attemptEmptyState(attempt),
  };
}

function sessionUserMessage(
  run: RunDetail,
  sessionIndex: number,
  session: RunSessionSummary | undefined,
  attempts: RunTimelineAttempt[],
): string | null {
  const latestPrompt = normalizedMessage(attempts.at(-1)?.prompt ?? null);
  if (latestPrompt !== null) {
    return latestPrompt;
  }

  if (sessionIndex === 0) {
    return normalizedMessage(run.message);
  }
  return normalizedMessage(session?.message ?? null);
}

function sessionUserSource(sessionIndex: number): RunChatUserRow["source"] {
  return sessionIndex === 0 ? "initial" : "resume";
}

export function deriveRunChatRows(
  run: RunDetail,
  history: RunTimelineHistory | null,
): RunChatRow[] {
  const attemptsBySession = new Map<number, RunTimelineAttempt[]>();
  for (const attempt of history?.attempts ?? []) {
    const attempts = attemptsBySession.get(attempt.sessionIndex) ?? [];
    attempts.push(attempt);
    attemptsBySession.set(attempt.sessionIndex, attempts);
  }

  for (const attempts of attemptsBySession.values()) {
    attempts.sort((left, right) => left.attemptNumber - right.attemptNumber);
  }

  const sessionsByIndex = new Map(run.sessions.map((session) => [session.sessionIndex, session]));
  const sessionIndexes = new Set<number>([
    ...run.sessions.map((session) => session.sessionIndex),
    ...attemptsBySession.keys(),
  ]);
  if (normalizedMessage(run.message) !== null) {
    sessionIndexes.add(0);
  }

  const rows: RunChatRow[] = [];
  for (const sessionIndex of [...sessionIndexes].sort((left, right) => left - right)) {
    const session = sessionsByIndex.get(sessionIndex);
    const attempts = attemptsBySession.get(sessionIndex) ?? [];
    const userMessage = sessionUserMessage(run, sessionIndex, session, attempts);
    if (userMessage !== null) {
      rows.push({
        id: `session:${sessionIndex}:user`,
        kind: "user",
        sessionIndex,
        source: sessionUserSource(sessionIndex),
        text: userMessage,
      });
    }

    const primaryAttempt = attempts.at(-1);
    if (!primaryAttempt) {
      continue;
    }

    rows.push({
      id: `session:${sessionIndex}:assistant:${primaryAttempt.attemptNumber}`,
      kind: "assistant",
      sessionIndex,
      ...toRetryAttempt(primaryAttempt),
      retryAttempts: attempts.slice(0, -1).map(toRetryAttempt),
    });
  }

  return rows;
}
