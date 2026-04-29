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

export interface RunChatSystemRow {
  id: string;
  kind: "system";
  sessionIndex: number;
  source: "initial" | "resume";
  text: string;
}

export interface RunChatAssistantRow {
  id: string;
  kind: "assistant";
  sessionIndex: number;
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

export type RunChatRow = RunChatUserRow | RunChatSystemRow | RunChatAssistantRow;

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

function toAssistantRow(attempt: RunTimelineAttempt): Omit<RunChatAssistantRow, "id" | "kind"> {
  return {
    sessionIndex: attempt.sessionIndex,
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
): string | null {
  if (sessionIndex === 0) {
    return normalizedMessage(run.message);
  }
  return normalizedMessage(session?.message ?? null);
}

function sessionSource(sessionIndex: number): "initial" | "resume" {
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
  const sessionIndexes = new Set<number>(attemptsBySession.keys());

  const rows: RunChatRow[] = [];
  for (const sessionIndex of [...sessionIndexes].sort((left, right) => left - right)) {
    const session = sessionsByIndex.get(sessionIndex);
    const attempts = attemptsBySession.get(sessionIndex) ?? [];
    const userMessage = sessionUserMessage(run, sessionIndex, session);
    const source = sessionSource(sessionIndex);
    if (userMessage !== null) {
      rows.push({
        id: `session:${sessionIndex}:user`,
        kind: "user",
        sessionIndex,
        source,
        text: userMessage,
      });
    }

    for (const attempt of attempts) {
      const systemMessage = normalizedMessage(attempt.prompt);
      const promptCoveredByUserMessage =
        attempt.attemptIndexInSession === 0 && userMessage !== null;
      if (systemMessage !== null && !promptCoveredByUserMessage) {
        rows.push({
          id: `session:${sessionIndex}:system:${attempt.attemptNumber}`,
          kind: "system",
          sessionIndex,
          source,
          text: systemMessage,
        });
      }

      rows.push({
        id: `session:${sessionIndex}:assistant:${attempt.attemptNumber}`,
        kind: "assistant",
        ...toAssistantRow(attempt),
      });
    }
  }

  return rows;
}
