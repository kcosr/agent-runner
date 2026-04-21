import type {
  RunAuditTimelineHistory,
  RunTimelineHistory,
} from "@task-runner/core/contracts/events.js";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAuditEnvelope, applyEnvelope, useRunAuditTimelineState } from "./run-timeline.js";

function makeHistory(overrides: Partial<RunTimelineHistory> = {}): RunTimelineHistory {
  return {
    runId: "run-1",
    attempts: [],
    lastCursor: 0,
    ...overrides,
  };
}

function makeAuditHistory(
  overrides: Partial<RunAuditTimelineHistory> = {},
): RunAuditTimelineHistory {
  return {
    runId: "run-1",
    attempts: [],
    events: [],
    lastCursor: 0,
    ...overrides,
  };
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {}

  emitMessage(payload: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("applyEnvelope", () => {
  it("adds a live attempt when an attempt starts", () => {
    const result = applyEnvelope(makeHistory(), {
      runId: "run-1",
      cursor: 1,
      event: {
        type: "attempt_started",
        attempt: 1,
        sessionIndex: 0,
        startedAt: "2026-04-15T10:00:00.000Z",
        prompt: "Write output",
      },
    });

    expect(result.requiresReload).toBe(false);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.attempts).toEqual([
      {
        attempt: 1,
        sessionIndex: 0,
        startedAt: "2026-04-15T10:00:00.000Z",
        endedAt: null,
        prompt: "Write output",
        transcript: "",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
      },
    ]);
  });

  it("appends transcript deltas to the active attempt", () => {
    const result = applyEnvelope(
      makeHistory({
        attempts: [
          {
            attempt: 1,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello",
            notices: "",
            exitCode: null,
            timedOut: false,
            live: true,
          },
        ],
        lastCursor: 1,
      }),
      {
        runId: "run-1",
        cursor: 2,
        event: {
          type: "agent_message_delta",
          text: " world",
        },
      },
    );

    expect(result.requiresReload).toBe(false);
    expect(result.history.attempts[0]?.transcript).toBe("Hello world");
  });

  it("appends backend notices to the active attempt notices", () => {
    const result = applyEnvelope(
      makeHistory({
        attempts: [
          {
            attempt: 1,
            sessionIndex: 0,
            startedAt: "2026-04-15T10:00:00.000Z",
            endedAt: null,
            prompt: "Write output",
            transcript: "Hello",
            notices: "warn:",
            exitCode: null,
            timedOut: false,
            live: true,
          },
        ],
        lastCursor: 1,
      }),
      {
        runId: "run-1",
        cursor: 2,
        event: {
          type: "backend_notice",
          text: " disk nearly full",
        },
      },
    );

    expect(result.requiresReload).toBe(false);
    expect(result.history.attempts[0]?.notices).toBe("warn: disk nearly full");
    expect(result.history.attempts[0]?.transcript).toBe("Hello");
  });

  it("treats unknown event types as requiring a reload", () => {
    const result = applyEnvelope(makeHistory({ lastCursor: 1 }), {
      runId: "run-1",
      cursor: 2,
      event: {
        type: "new_event_type",
      } as unknown as Parameters<typeof applyEnvelope>[1]["event"],
    });

    expect(result.requiresReload).toBe(true);
    expect(result.history.lastCursor).toBe(1);
  });
});

describe("applyAuditEnvelope", () => {
  it("appends audit events in cursor order", () => {
    const result = applyAuditEnvelope(makeAuditHistory(), {
      runId: "run-1",
      cursor: 1,
      recordedAt: "2026-04-21T12:41:02.000Z",
      event: {
        type: "run.created",
        source: "system",
        hostMode: "embedded",
      },
    });

    expect(result.requiresReload).toBe(false);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.events[0]?.event.type).toBe("run.created");
  });

  it("requests a reload on an audit cursor gap", () => {
    const result = applyAuditEnvelope(makeAuditHistory({ lastCursor: 1 }), {
      runId: "run-1",
      cursor: 3,
      recordedAt: "2026-04-21T12:41:04.000Z",
      event: {
        type: "task.updated",
        source: "task_command",
        hostMode: "embedded",
      },
    });

    expect(result.requiresReload).toBe(true);
    expect(result.history.lastCursor).toBe(1);
    expect(result.history.events).toHaveLength(0);
  });
});

describe("useRunAuditTimelineState", () => {
  it("buffers pre-bootstrap audit events and reloads on cursor gaps", async () => {
    const config = {
      apiBasePath: "/api",
      runSummaryEventsPath: "/api/events/run-summaries",
    };
    const auditHistory = makeAuditHistory({
      lastCursor: 1,
      events: [
        {
          runId: "run-1",
          cursor: 1,
          recordedAt: "2026-04-21T12:41:02.000Z",
          event: {
            type: "run.created",
            source: "system",
            hostMode: "embedded",
          },
        },
      ],
    });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ history: auditHistory }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useRunAuditTimelineState({
        config,
        runId: "run-1",
        runIsLive: true,
      }),
    );
    const source = MockEventSource.instances.find((candidate) =>
      candidate.url.endsWith("/api/runs/run-1/events/audit"),
    );
    expect(source).toBeDefined();

    source?.emitMessage({
      runId: "run-1",
      cursor: 2,
      recordedAt: "2026-04-21T12:41:03.000Z",
      event: {
        type: "task.updated",
        source: "task_command",
        hostMode: "embedded",
        taskId: "orient",
        statusAfter: "completed",
      },
    });
    source?.emitOpen();

    await waitFor(() => expect(result.current.history?.lastCursor).toBe(2));
    expect(result.current.history?.events).toHaveLength(2);

    auditHistory.lastCursor = 3;
    auditHistory.events = [
      ...auditHistory.events,
      {
        runId: "run-1",
        cursor: 3,
        recordedAt: "2026-04-21T12:41:04.000Z",
        event: {
          type: "run.finished",
          source: "system",
          hostMode: "embedded",
          terminalStatus: "success",
        },
      },
    ];

    source?.emitMessage({
      runId: "run-1",
      cursor: 5,
      recordedAt: "2026-04-21T12:41:06.000Z",
      event: {
        type: "future.event",
        source: "system",
        hostMode: "embedded",
      },
    });

    await waitFor(() => expect(result.current.history?.lastCursor).toBe(3));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
