import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendRunScheduleAdvancedEvent,
  appendRunScheduleFailedEvent,
  appendRunScheduleSetEvent,
  readRunAuditHistory,
  systemRunEventContext,
} from "../packages/core/dist/core/run/run-events.js";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "agent-runner-schedule-audit-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const manifest = (workspaceDir) => ({
  workspaceDir,
  runId: "run-schedule",
});

test("schedule audit helpers append typed schedule events and reason fields", () => {
  const workspaceDir = workspace();
  const schedule = {
    enabled: true,
    runAt: "2026-04-25T15:00:00.000Z",
    recurrence: null,
  };
  const nextSchedule = {
    ...schedule,
    runAt: "2026-04-26T15:00:00.000Z",
  };

  appendRunScheduleSetEvent({
    manifest: manifest(workspaceDir),
    context: systemRunEventContext(),
    schedule,
    previousSchedule: null,
  });
  appendRunScheduleAdvancedEvent({
    manifest: manifest(workspaceDir),
    context: systemRunEventContext(),
    previousSchedule: schedule,
    schedule: nextSchedule,
    reason: "overdue_on_startup",
  });
  appendRunScheduleFailedEvent({
    manifest: manifest(workspaceDir),
    context: systemRunEventContext(),
    schedule: nextSchedule,
    reason: "start_failed",
    error: "synthetic schedule failure",
  });

  const history = readRunAuditHistory({ workspaceDir, runId: "run-schedule" });

  assert.equal(history.events.length, 3);
  assert.equal(history.events[0].event.type, "run.schedule_set");
  assert.deepEqual(history.events[0].event.fields.schedule, schedule);
  assert.equal(history.events[1].event.type, "run.schedule_advanced");
  assert.deepEqual(history.events[1].event.fields.previousSchedule, schedule);
  assert.deepEqual(history.events[1].event.fields.schedule, nextSchedule);
  assert.equal(history.events[1].event.fields.reason, "overdue_on_startup");
  assert.equal(history.events[2].event.type, "run.schedule_failed");
  assert.deepEqual(history.events[2].event.fields.schedule, nextSchedule);
  assert.equal(history.events[2].event.fields.reason, "start_failed");
  assert.equal(history.events[2].event.fields.error, "synthetic schedule failure");
});
