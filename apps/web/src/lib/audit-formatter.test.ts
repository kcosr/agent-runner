import { describe, expect, it } from "vitest";
import { formatAuditEvent } from "./audit-formatter.js";

describe("formatAuditEvent", () => {
  it("returns structured message parts for known audit events", () => {
    const formatted = formatAuditEvent({
      type: "run.finished",
      recordedAt: "2026-04-15T10:00:00.000Z",
      source: "system",
      hostMode: "embedded",
      fields: {
        terminalStatus: "success",
        exitCode: 0,
        tasksCompleted: 2,
        tasksTotal: 2,
      },
    });

    expect(formatted.message).toEqual([
      { type: "text", text: "Finished run as " },
      { type: "status", status: "success" },
      { type: "text", text: " with " },
      { type: "code", text: "2" },
      { type: "text", text: "/" },
      { type: "code", text: "2" },
      { type: "text", text: " tasks complete." },
    ]);
  });

  it("falls back to a raw code fragment for unknown event types", () => {
    const formatted = formatAuditEvent({
      type: "custom.future_event",
      recordedAt: "2026-04-15T10:00:00.000Z",
      source: "system",
      hostMode: "embedded",
      fields: {
        reason: "future",
      },
    } as never);

    expect(formatted.message).toEqual([
      { type: "text", text: "Recorded " },
      { type: "code", text: "custom.future_event" },
      { type: "text", text: "." },
    ]);
  });
});
