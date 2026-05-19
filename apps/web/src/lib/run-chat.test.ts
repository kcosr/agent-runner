import type { RunAttachment } from "@kcosr/agent-runner-core/contracts/attachments.js";
import type {
  RunTimelineAttempt,
  RunTimelineHistory,
} from "@kcosr/agent-runner-core/contracts/events.js";
import type { RunDetail, RunSessionSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import { describe, expect, it } from "vitest";
import { type RunChatAssistantRow, deriveRunChatRows } from "./run-chat.js";

function makeSession(overrides: Partial<RunSessionSummary>): RunSessionSummary {
  return {
    sessionIndex: 0,
    status: "success",
    startedAt: "2026-04-28T10:00:00.000Z",
    endedAt: "2026-04-28T10:05:00.000Z",
    exitCode: 0,
    message: null,
    firstAttemptNumber: null,
    lastAttemptNumber: null,
    attemptCount: 0,
    maxAttemptsPerSession: 3,
    backendSessionIdAtStart: null,
    backendSessionIdAtEnd: null,
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<RunTimelineAttempt>): RunTimelineAttempt {
  return {
    attemptNumber: 1,
    sessionIndex: 0,
    attemptIndexInSession: 0,
    startedAt: "2026-04-28T10:00:00.000Z",
    endedAt: "2026-04-28T10:05:00.000Z",
    prompt: "Prompt text",
    transcript: "Assistant response",
    notices: "",
    exitCode: 0,
    timedOut: false,
    live: false,
    provenance: { kind: "task_runner" },
    ...overrides,
  };
}

function makeHistory(attempts: RunTimelineAttempt[]): RunTimelineHistory {
  return {
    runId: "run-1",
    attempts,
    lastCursor: 1,
  };
}

function makeAttachment(
  overrides: Partial<RunAttachment> & Pick<RunAttachment, "id">,
): RunAttachment {
  return {
    id: overrides.id,
    name: overrides.name ?? `${overrides.id}.txt`,
    mimeType: overrides.mimeType ?? "text/plain",
    size: overrides.size ?? 12,
    sha256: overrides.sha256 ?? "abc123",
    addedAt: overrides.addedAt ?? "2026-04-28T10:02:00.000Z",
    relativePath: overrides.relativePath ?? `attachments/${overrides.id}/${overrides.id}.txt`,
  };
}

function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "run-1",
    parentRunId: null,
    runGroupId: "run-1",
    repo: "agent-runner",
    status: "success",
    effectiveStatus: "success",
    archivedAt: null,
    isLive: false,
    workspaceDir: "/tmp/agent-runner/run-1",
    agent: {
      name: "implementer",
      sourcePath: null,
    },
    assignment: null,
    backend: "codex",
    model: "gpt-5",
    effort: "medium",
    name: null,
    note: null,
    pinned: false,
    backendSessionId: null,
    cwd: "/tmp/agent-runner",
    unrestricted: false,
    timeoutSec: 3600,
    startedAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:05:00.000Z",
    endedAt: "2026-04-28T10:05:00.000Z",
    exitCode: 0,
    totalAttemptCount: 0,
    totalSessionCount: 0,
    maxAttemptsPerSession: 3,
    sessions: [],
    currentSession: null,
    lastSession: null,
    tasksCompleted: 0,
    tasksTotal: 0,
    attachments: [],
    queuedResumeMessages: [],
    dependencies: [],
    dependents: [],
    schedule: null,
    scheduleState: "none",
    tasks: [],
    activeTask: null,
    message: null,
    pendingPrompt: null,
    callerInstructions: null,
    lockedFields: [],
    runtimeVars: {},
    execution: {
      hostMode: "embedded",
      controller: { kind: "embedded" },
    },
    executionEnvironment: null,
    capabilities: {
      canArchive: true,
      canUnarchive: false,
      canReset: true,
      canDelete: false,
      canReady: false,
      canResume: true,
      canAbort: false,
      abortReason: "not_active_in_daemon",
      canReconfigure: false,
      taskMutation: {
        canAdd: false,
        canEditPending: false,
        canDeletePending: false,
        canEditNotes: false,
        canSetStatus: false,
      },
    },
    ...overrides,
  };
}

function assistantRows(rows: ReturnType<typeof deriveRunChatRows>): RunChatAssistantRow[] {
  return rows.filter((row): row is RunChatAssistantRow => row.kind === "assistant");
}

describe("deriveRunChatRows", () => {
  it("does not derive user rows from run or session messages before attempts exist", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "  Initial request  ",
        sessions: [
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: "   " }),
          makeSession({ sessionIndex: 2, message: " Follow-up " }),
        ],
      }),
      makeHistory([]),
    );

    expect(rows).toEqual([]);
  });

  it("derives a pending system row from an initialized run pending prompt before attempts exist", () => {
    const rows = deriveRunChatRows(
      makeRun({
        status: "initialized",
        effectiveStatus: "initialized",
        message: "  Initial request  ",
        pendingPrompt: "  ## Pending prompt  ",
      }),
      makeHistory([]),
    );

    expect(rows).toEqual([
      {
        id: "session:0:system:pending",
        kind: "system",
        sessionIndex: 0,
        source: "initial",
        status: "pending",
        text: "## Pending prompt",
        turnDivider: {
          id: "pending",
          timestamp: "2026-04-28T10:00:00.000Z",
        },
      },
    ]);
  });

  it("derives a pending system row from a ready run without an initial user row", () => {
    const rows = deriveRunChatRows(
      makeRun({
        status: "ready",
        effectiveStatus: "ready",
        message: "Initial request",
        pendingPrompt: "Ready pending prompt",
      }),
      makeHistory([]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "system",
      source: "initial",
      status: "pending",
      text: "Ready pending prompt",
    });
    expect(rows.some((row) => row.kind === "user")).toBe(false);
  });

  it("does not render a pending row when status is not initialized or ready", () => {
    const rows = deriveRunChatRows(
      makeRun({
        status: "running",
        effectiveStatus: "running",
        pendingPrompt: "Stale pending prompt",
      }),
      makeHistory([]),
    );

    expect(rows).toEqual([]);
  });

  it("replaces the pending row with the first real attempt prompt once attempts exist", () => {
    const pendingRun = makeRun({
      status: "initialized",
      effectiveStatus: "initialized",
      message: "Initial request",
      pendingPrompt: "Pending prompt",
      sessions: [makeSession({ sessionIndex: 0, message: null })],
    });

    expect(deriveRunChatRows(pendingRun, makeHistory([]))).toMatchObject([
      {
        kind: "system",
        status: "pending",
        text: "Pending prompt",
      },
    ]);

    const rows = deriveRunChatRows(
      {
        ...pendingRun,
        status: "running",
        effectiveStatus: "running",
        totalAttemptCount: 1,
      },
      makeHistory([makeAttempt({ prompt: "First real attempt prompt" })]),
    );

    expect(rows.map((row) => row.id)).toEqual(["session:0:system:1", "session:0:assistant:1"]);
    expect(rows[0]).toMatchObject({
      kind: "system",
      status: "sent",
      text: "First real attempt prompt",
    });
    expect(rows.some((row) => row.id === "session:0:system:pending")).toBe(false);
    expect(rows.some((row) => row.kind === "user")).toBe(false);
  });

  it("uses attempt prompt as authoritative when the first attempt prompt is blank", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "User typed initial request",
        sessions: [makeSession({ sessionIndex: 0, message: null })],
      }),
      makeHistory([makeAttempt({ prompt: "   " })]),
    );

    expect(rows.map((row) => row.id)).toEqual(["session:0:assistant:1"]);
    expect(rows.some((row) => row.kind === "user" || row.kind === "system")).toBe(false);
  });

  it("sorts sessions and renders attempts chronologically", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "  Initial  ",
        sessions: [
          makeSession({ sessionIndex: 2, message: "Second resume" }),
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: " First resume " }),
        ],
      }),
      makeHistory([
        makeAttempt({
          sessionIndex: 1,
          attemptNumber: 4,
          attemptIndexInSession: 1,
          prompt: "",
          transcript: "latest session 1",
        }),
        makeAttempt({
          sessionIndex: 0,
          attemptNumber: 2,
          attemptIndexInSession: 1,
          prompt: "",
          transcript: "latest session 0",
        }),
        makeAttempt({ sessionIndex: 1, attemptNumber: 3, transcript: "prior session 1" }),
        makeAttempt({ sessionIndex: 0, attemptNumber: 1, transcript: "prior session 0" }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:system:1",
      "session:0:assistant:1",
      "session:0:assistant:2",
      "session:1:user",
      "session:1:assistant:3",
      "session:1:assistant:4",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "system",
      source: "initial",
      status: "sent",
      text: "Prompt text",
      turnDivider: {
        id: "attempt:1",
        timestamp: "2026-04-28T10:00:00.000Z",
      },
    });
    expect(rows[3]).toMatchObject({
      kind: "user",
      source: "resume",
      text: "First resume",
      turnDivider: {
        id: "session:1",
        timestamp: "2026-04-28T10:00:00.000Z",
      },
    });
    expect(rows[1]).toMatchObject({
      kind: "assistant",
      transcript: "prior session 0",
    });
    expect(rows[2]).toMatchObject({
      kind: "assistant",
      transcript: "latest session 0",
    });
    expect(rows[4]).toMatchObject({
      kind: "assistant",
      transcript: "prior session 1",
    });
    expect(rows[5]).toMatchObject({
      kind: "assistant",
      transcript: "latest session 1",
    });
  });

  it("emits a system row from the attempt prompt when the session has no user message", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: null,
        sessions: [
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: "   " }),
        ],
      }),
      makeHistory([
        makeAttempt({ sessionIndex: 0, attemptNumber: 1, prompt: "Initial bootstrap prompt" }),
        makeAttempt({ sessionIndex: 1, attemptNumber: 2, prompt: " Resume reminder " }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:system:1",
      "session:0:assistant:1",
      "session:1:system:2",
      "session:1:assistant:2",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "system",
      source: "initial",
      status: "sent",
      text: "Initial bootstrap prompt",
    });
    expect(rows[2]).toMatchObject({
      kind: "system",
      source: "resume",
      status: "sent",
      text: "Resume reminder",
    });
  });

  it("suppresses system rows for bootstrap-imported backend session prompts", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: "Existing backend prompt" })],
      }),
      makeHistory([
        makeAttempt({
          sessionIndex: 0,
          attemptNumber: 1,
          prompt: "Existing backend prompt",
          provenance: { kind: "backend_session", mode: "bootstrap" },
        }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual(["session:0:user", "session:0:assistant:1"]);
    expect(rows[0]).toMatchObject({
      kind: "user",
      source: "initial",
      text: "Existing backend prompt",
      turnDivider: {
        id: "session:0",
        timestamp: "2026-04-28T10:00:00.000Z",
      },
    });
    expect(rows[1]).toMatchObject({
      kind: "assistant",
      transcript: "Assistant response",
    });
    expect(rows[1]).not.toHaveProperty("turnDivider");
  });

  it("keeps bootstrap-imported prompt text when no session message covers it", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
      }),
      makeHistory([
        makeAttempt({
          sessionIndex: 0,
          attemptNumber: 1,
          prompt: "Existing backend prompt",
          provenance: { kind: "backend_session", mode: "bootstrap" },
        }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual(["session:0:system:1", "session:0:assistant:1"]);
    expect(rows[0]).toMatchObject({
      kind: "system",
      source: "initial",
      status: "sent",
      text: "Existing backend prompt",
    });
  });

  it("renders automatic follow-up attempt prompts as system cards", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: null,
        sessions: [makeSession({ sessionIndex: 0, message: null })],
      }),
      makeHistory([
        makeAttempt({
          attemptNumber: 1,
          attemptIndexInSession: 0,
          prompt: "Initial bootstrap prompt",
          transcript: "First response",
        }),
        makeAttempt({
          attemptNumber: 2,
          attemptIndexInSession: 1,
          prompt: "Some tasks are not yet completed. Please continue.",
          transcript: "Follow-up response",
        }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:system:1",
      "session:0:assistant:1",
      "session:0:system:2",
      "session:0:assistant:2",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "system",
      status: "sent",
      text: "Initial bootstrap prompt",
    });
    expect(rows[2]).toMatchObject({
      kind: "system",
      status: "sent",
      text: "Some tasks are not yet completed. Please continue.",
    });
  });

  it("renders the initial attempt prompt instead of a duplicate initial user message", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "User typed initial",
        sessions: [makeSession({ sessionIndex: 0, message: null })],
      }),
      makeHistory([
        makeAttempt({
          sessionIndex: 0,
          attemptNumber: 1,
          prompt: "agent prefix\n\nUser typed initial",
        }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual(["session:0:system:1", "session:0:assistant:1"]);
    expect(rows[0]).toMatchObject({
      kind: "system",
      source: "initial",
      status: "sent",
      text: "agent prefix\n\nUser typed initial",
    });
    expect(rows.some((row) => row.kind === "user")).toBe(false);
  });

  it("preserves resume-session user message behavior and follow-up system prompts", () => {
    const rows = deriveRunChatRows(
      makeRun({
        message: "User typed initial",
        sessions: [
          makeSession({ sessionIndex: 0, message: null }),
          makeSession({ sessionIndex: 1, message: "User typed resume" }),
        ],
      }),
      makeHistory([
        makeAttempt({
          sessionIndex: 0,
          attemptNumber: 1,
          prompt: "Initial prompt",
        }),
        makeAttempt({
          sessionIndex: 1,
          attemptNumber: 2,
          attemptIndexInSession: 0,
          prompt: "tasks-reminder\n\nUser typed resume",
        }),
        makeAttempt({
          sessionIndex: 1,
          attemptNumber: 3,
          attemptIndexInSession: 1,
          prompt: "Automatic retry prompt",
        }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:system:1",
      "session:0:assistant:1",
      "session:1:user",
      "session:1:assistant:2",
      "session:1:system:3",
      "session:1:assistant:3",
    ]);
    expect(rows[0]).toMatchObject({ kind: "system", text: "Initial prompt" });
    expect(rows[2]).toMatchObject({ kind: "user", text: "User typed resume" });
    expect(rows[4]).toMatchObject({ kind: "system", text: "Automatic retry prompt" });
    expect(rows[2]?.turnDivider).toMatchObject({
      id: "session:1",
      timestamp: "2026-04-28T10:00:00.000Z",
    });
    expect(rows[4]?.turnDivider).toMatchObject({
      id: "attempt:3",
      timestamp: "2026-04-28T10:00:00.000Z",
    });
  });

  it("retains live or empty transcript states on the assistant row", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
      }),
      makeHistory([
        makeAttempt({
          attemptNumber: 1,
          transcript: "",
          notices: "backend notice",
          prompt: "first prompt",
          live: false,
          provenance: { kind: "task_runner" },
        }),
        makeAttempt({
          attemptNumber: 2,
          transcript: "   ",
          notices: "live notice",
          prompt: "live prompt",
          live: true,
          provenance: { kind: "task_runner" },
          endedAt: null,
          exitCode: null,
        }),
      ]),
    );

    expect(rows.map((row) => row.id)).toEqual([
      "session:0:system:1",
      "session:0:assistant:1",
      "session:0:system:2",
      "session:0:assistant:2",
    ]);
    expect(rows[0]).toMatchObject({ kind: "system", text: "first prompt" });
    expect(rows[1]).toMatchObject({
      kind: "assistant",
      transcript: "",
      hasTranscript: false,
      emptyState: "no_response_recorded",
    });
    expect(rows[2]).toMatchObject({ kind: "system", text: "live prompt" });
    expect(rows[3]).toMatchObject({
      kind: "assistant",
      transcript: "   ",
      hasTranscript: false,
      emptyState: "waiting_live_response",
    });
  });

  it("matches selected-run attachments inside completed attempt windows inclusively and sorts by addedAt", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
        attachments: [
          makeAttachment({ id: "att-end", addedAt: "2026-04-28T10:05:00.000Z" }),
          makeAttachment({ id: "att-middle", addedAt: "2026-04-28T10:03:00.000Z" }),
          makeAttachment({ id: "att-start", addedAt: "2026-04-28T10:00:00.000Z" }),
        ],
      }),
      makeHistory([makeAttempt({ attemptNumber: 1 })]),
    );

    expect(assistantRows(rows)[0]?.artifacts.map((artifact) => artifact.id)).toEqual([
      "att-start",
      "att-middle",
      "att-end",
    ]);
  });

  it("attaches overlapping-window matches to the earliest matching attempt number", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
        attachments: [makeAttachment({ id: "att-overlap", addedAt: "2026-04-28T10:04:00.000Z" })],
      }),
      makeHistory([
        makeAttempt({
          attemptNumber: 2,
          startedAt: "2026-04-28T10:03:00.000Z",
          endedAt: "2026-04-28T10:06:00.000Z",
        }),
        makeAttempt({
          attemptNumber: 1,
          startedAt: "2026-04-28T10:00:00.000Z",
          endedAt: "2026-04-28T10:05:00.000Z",
        }),
      ]),
    );

    const assistant = assistantRows(rows);
    expect(assistant[0]?.artifacts.map((artifact) => artifact.id)).toEqual(["att-overlap"]);
    expect(assistant[1]?.artifacts).toEqual([]);
  });

  it("excludes attachments outside completed attempts when there is no live match", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
        attachments: [
          makeAttachment({ id: "att-before", addedAt: "2026-04-28T09:59:59.999Z" }),
          makeAttachment({ id: "att-after", addedAt: "2026-04-28T10:05:00.001Z" }),
        ],
      }),
      makeHistory([makeAttempt({ attemptNumber: 1 })]),
    );

    expect(assistantRows(rows)[0]?.artifacts).toEqual([]);
  });

  it("matches attachments to open-ended live attempts", () => {
    const rows = deriveRunChatRows(
      makeRun({
        sessions: [makeSession({ sessionIndex: 0, message: null })],
        attachments: [
          makeAttachment({ id: "att-before-live", addedAt: "2026-04-28T10:09:59.999Z" }),
          makeAttachment({ id: "att-live", addedAt: "2026-04-28T10:10:00.000Z" }),
          makeAttachment({ id: "att-later-live", addedAt: "2026-04-28T10:11:00.000Z" }),
        ],
      }),
      makeHistory([
        makeAttempt({
          attemptNumber: 1,
          startedAt: "2026-04-28T10:00:00.000Z",
          endedAt: "2026-04-28T10:05:00.000Z",
        }),
        makeAttempt({
          attemptNumber: 2,
          startedAt: "2026-04-28T10:10:00.000Z",
          endedAt: null,
          exitCode: null,
          live: true,
          provenance: { kind: "task_runner" },
        }),
      ]),
    );

    const assistant = assistantRows(rows);
    expect(assistant[0]?.artifacts).toEqual([]);
    expect(assistant[1]?.artifacts.map((artifact) => artifact.id)).toEqual([
      "att-live",
      "att-later-live",
    ]);
  });

  it("omits artifact cards after attachments are removed from the selected run", () => {
    const attachment = makeAttachment({
      id: "att-removed",
      addedAt: "2026-04-28T10:02:00.000Z",
    });
    const history = makeHistory([makeAttempt({ attemptNumber: 1 })]);
    const run = makeRun({
      sessions: [makeSession({ sessionIndex: 0, message: null })],
      attachments: [attachment],
    });

    expect(assistantRows(deriveRunChatRows(run, history))[0]?.artifacts).toHaveLength(1);
    expect(
      assistantRows(
        deriveRunChatRows(
          {
            ...run,
            attachments: [],
          },
          history,
        ),
      )[0]?.artifacts,
    ).toEqual([]);
  });
});
