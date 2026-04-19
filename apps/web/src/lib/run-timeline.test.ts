import type { RunTimelineHistory } from "@task-runner/core/contracts/events.js";
import { describe, expect, it } from "vitest";
import { applyEnvelope } from "./run-timeline.js";

function makeHistory(overrides: Partial<RunTimelineHistory> = {}): RunTimelineHistory {
  return {
    runId: "run-1",
    attempts: [],
    lastCursor: 0,
    ...overrides,
  };
}

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
