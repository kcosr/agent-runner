import type { RunAttachment } from "@agent-runner/core/contracts/attachments.js";
import type {
  RunTimelineAttempt,
  RunTimelineHistory,
} from "@agent-runner/core/contracts/events.js";
import type { RunDetail, RunSessionSummary } from "@agent-runner/core/contracts/runs.js";

export type RunChatAssistantEmptyState = "waiting_live_response" | "no_response_recorded";

export interface RunChatTurnDivider {
  id: string;
  timestamp: string;
}

interface RunChatRowBase {
  id: string;
  turnDivider?: RunChatTurnDivider;
}

interface RunChatUserRow extends RunChatRowBase {
  kind: "user";
  sessionIndex: number;
  source: "initial" | "resume";
  text: string;
}

export interface RunChatSystemRow extends RunChatRowBase {
  kind: "system";
  sessionIndex: number;
  source: "initial" | "resume";
  status: "pending" | "sent";
  text: string;
}

export type RunChatAttachmentArtifact = Pick<
  RunAttachment,
  "id" | "name" | "mimeType" | "size" | "addedAt"
>;

export interface RunChatAssistantRow extends RunChatRowBase {
  kind: "assistant";
  transcript: string;
  hasTranscript: boolean;
  emptyState?: RunChatAssistantEmptyState;
  artifacts: RunChatAttachmentArtifact[];
}

export type RunChatRow = RunChatUserRow | RunChatSystemRow | RunChatAssistantRow;

interface AttemptWindow {
  attemptNumber: number;
  endedAt: number | null;
  startedAt: number;
}

function normalizedMessage(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function toAssistantRow(
  attempt: RunTimelineAttempt,
  artifacts: RunChatAttachmentArtifact[],
): Omit<RunChatAssistantRow, "id" | "kind"> {
  const hasTranscript = attempt.transcript.trim().length > 0;
  return {
    transcript: attempt.transcript,
    hasTranscript,
    emptyState: hasTranscript
      ? undefined
      : attempt.live
        ? "waiting_live_response"
        : "no_response_recorded",
    artifacts,
  };
}

function isBootstrapAttempt(attempt: RunTimelineAttempt): boolean {
  return attempt.provenance.kind === "backend_session" && attempt.provenance.mode === "bootstrap";
}

function sessionUserMessage(
  sessionIndex: number,
  session: RunSessionSummary | undefined,
  options: { includeInitial: boolean },
): string | null {
  if (sessionIndex === 0 && !options.includeInitial) {
    return null;
  }
  return normalizedMessage(session?.message ?? null);
}

function sessionSource(sessionIndex: number): "initial" | "resume" {
  return sessionIndex === 0 ? "initial" : "resume";
}

function turnDivider(id: string, timestamp: string): RunChatTurnDivider {
  return { id, timestamp };
}

function attachmentAddedAtSort(
  left: RunChatAttachmentArtifact,
  right: RunChatAttachmentArtifact,
): number {
  const addedAtOrder = Date.parse(left.addedAt) - Date.parse(right.addedAt);
  return addedAtOrder === 0 ? left.id.localeCompare(right.id) : addedAtOrder;
}

function attemptMatchesAttachment(window: AttemptWindow, attachmentAddedAt: number): boolean {
  if (window.endedAt === null) {
    return attachmentAddedAt >= window.startedAt;
  }
  return attachmentAddedAt >= window.startedAt && attachmentAddedAt <= window.endedAt;
}

function deriveArtifactsByAttempt(
  attachments: RunAttachment[],
  attempts: RunTimelineAttempt[],
): Map<number, RunChatAttachmentArtifact[]> {
  const artifactsByAttempt = new Map<number, RunChatAttachmentArtifact[]>();
  if (attachments.length === 0 || attempts.length === 0) {
    return artifactsByAttempt;
  }

  const attemptWindows = attempts
    .map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      startedAt: Date.parse(attempt.startedAt),
      endedAt: attempt.endedAt === null ? null : Date.parse(attempt.endedAt),
    }))
    .sort((left, right) => left.attemptNumber - right.attemptNumber);

  for (const attachment of attachments) {
    const attachmentAddedAt = Date.parse(attachment.addedAt);
    const matchingWindow = attemptWindows.find((window) =>
      attemptMatchesAttachment(window, attachmentAddedAt),
    );
    if (!matchingWindow) {
      continue;
    }

    const artifacts = artifactsByAttempt.get(matchingWindow.attemptNumber) ?? [];
    artifacts.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      addedAt: attachment.addedAt,
    });
    artifactsByAttempt.set(matchingWindow.attemptNumber, artifacts);
  }

  for (const artifacts of artifactsByAttempt.values()) {
    artifacts.sort(attachmentAddedAtSort);
  }

  return artifactsByAttempt;
}

export function deriveRunChatRows(run: RunDetail, history: RunTimelineHistory): RunChatRow[] {
  const pendingPromptAvailable =
    (run.status === "initialized" || run.status === "ready") &&
    run.totalAttemptCount === 0 &&
    history.attempts.length === 0;
  if (pendingPromptAvailable) {
    const pendingPrompt = normalizedMessage(run.pendingPrompt);
    if (pendingPrompt !== null) {
      return [
        {
          id: "session:0:system:pending",
          kind: "system",
          sessionIndex: 0,
          source: "initial",
          status: "pending",
          text: pendingPrompt,
          turnDivider: turnDivider("pending", run.startedAt),
        },
      ];
    }
  }

  const attemptsBySession = new Map<number, RunTimelineAttempt[]>();
  for (const attempt of history.attempts) {
    const attempts = attemptsBySession.get(attempt.sessionIndex) ?? [];
    attempts.push(attempt);
    attemptsBySession.set(attempt.sessionIndex, attempts);
  }

  for (const attempts of attemptsBySession.values()) {
    attempts.sort((left, right) => left.attemptNumber - right.attemptNumber);
  }

  const artifactsByAttempt = deriveArtifactsByAttempt(run.attachments, history.attempts);
  const sessionsByIndex = new Map(run.sessions.map((session) => [session.sessionIndex, session]));
  const sessionIndexes = new Set<number>(attemptsBySession.keys());

  const rows: RunChatRow[] = [];
  for (const sessionIndex of [...sessionIndexes].sort((left, right) => left - right)) {
    const session = sessionsByIndex.get(sessionIndex);
    const attempts = attemptsBySession.get(sessionIndex) ?? [];
    const hasBootstrapHistory = attempts.some(isBootstrapAttempt);
    const userMessage = sessionUserMessage(sessionIndex, session, {
      includeInitial: hasBootstrapHistory,
    });
    const source = sessionSource(sessionIndex);
    if (userMessage !== null) {
      rows.push({
        id: `session:${sessionIndex}:user`,
        kind: "user",
        sessionIndex,
        source,
        text: userMessage,
        turnDivider: turnDivider(
          `session:${sessionIndex}`,
          session?.startedAt ?? attempts[0]?.startedAt ?? run.startedAt,
        ),
      });
    }

    for (const attempt of attempts) {
      const systemMessage = normalizedMessage(attempt.prompt);
      const promptCoveredByUserMessage =
        sessionIndex > 0 && attempt.attemptIndexInSession === 0 && userMessage !== null;
      const promptCoveredByBootstrapHistory = isBootstrapAttempt(attempt) && userMessage !== null;
      const promptCovered = promptCoveredByUserMessage || promptCoveredByBootstrapHistory;
      const attemptDivider = promptCovered
        ? undefined
        : turnDivider(`attempt:${attempt.attemptNumber}`, attempt.startedAt);
      if (systemMessage !== null && !promptCovered) {
        rows.push({
          id: `session:${sessionIndex}:system:${attempt.attemptNumber}`,
          kind: "system",
          sessionIndex,
          source,
          status: "sent",
          text: systemMessage,
          ...(attemptDivider ? { turnDivider: attemptDivider } : {}),
        });
      }

      rows.push({
        id: `session:${sessionIndex}:assistant:${attempt.attemptNumber}`,
        kind: "assistant",
        ...(systemMessage !== null && !promptCovered
          ? {}
          : attemptDivider
            ? { turnDivider: attemptDivider }
            : {}),
        ...toAssistantRow(attempt, artifactsByAttempt.get(attempt.attemptNumber) ?? []),
      });
    }
  }

  return rows;
}
