import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { updateTasksForPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const ABORT_AGENT = `---
schemaVersion: 1
name: aborter
backend: claude
---
Agent role.
`;

const ABORT_ASSIGNMENT = `---
schemaVersion: 1
name: aborter-work
maxRetries: 2
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-abort-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent.md");
  writeFileSync(path, body);
  return path;
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "assignment.md");
  writeFileSync(path, body);
  return path;
}

function setup(baseDir) {
  writeAgent(baseDir, "aborter", ABORT_AGENT);
  writeAssignment(baseDir, "aborter-work", ABORT_ASSIGNMENT);
}

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

async function runIn(baseDir, opts) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("aborter", baseDir);
    const loadedAssignment = loadAssignmentConfig("aborter-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        abortSignal: opts.abortSignal,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("abort: backend signals aborted; run terminates with status=aborted, exit 130", async () => {
  const dir = tempDir();
  setup(dir);

  const controller = new AbortController();

  let invokeCount = 0;
  const outcome = await runIn(dir, {
    abortSignal: controller.signal,
    backend: mockBackend(async (ctx) => {
      invokeCount++;
      // Simulate the user pressing Ctrl+C while the backend is running.
      // A real backend (codex) would receive this via ctx.abortSignal,
      // send turn/interrupt, and then return aborted: true.
      assert.ok(ctx.abortSignal, "backend received abortSignal in context");
      controller.abort();
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        aborted: true,
        sessionId: "sess-aborted",
        transcript: null,
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(invokeCount, 1, "no retry after abort");
  assert.equal(outcome.exitCode, 130);
  assert.equal(outcome.summary.status, "aborted");
  assert.equal(outcome.manifest.status, "aborted");
  assert.equal(outcome.manifest.sessions.length, 1);
  assert.equal(outcome.manifest.sessions[0].status, "aborted");
  assert.equal(outcome.manifest.sessions[0].exitCode, 130);
  assert.equal(outcome.manifest.totalAttemptCount, 1);
});

test("abort: aborted run is resumable from the same workspace", async () => {
  const dir = tempDir();
  setup(dir);

  const controller = new AbortController();
  const aborted = await runIn(dir, {
    abortSignal: controller.signal,
    backend: mockBackend(async () => {
      controller.abort();
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        aborted: true,
        sessionId: "sess-resumable",
        transcript: null,
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(aborted.manifest.status, "aborted");
  assert.equal(aborted.manifest.backendSessionId, "sess-resumable");
});

test("abort: terminal persistence clears stale in-progress tasks for non-passive runs", async () => {
  const dir = tempDir();
  setup(dir);

  const controller = new AbortController();
  const aborted = await runIn(dir, {
    abortSignal: controller.signal,
    backend: mockBackend(async (ctx) => {
      updateTasksForPrompt(ctx.prompt, {
        t1: { status: "in_progress", notes: "Halfway done" },
        t2: { status: "completed", notes: "Wrapped up" },
      });
      controller.abort();
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        aborted: true,
        sessionId: "sess-reset-progress",
        transcript: null,
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(aborted.manifest.status, "aborted");
  assert.equal(aborted.manifest.finalTasks.t1.status, "pending");
  assert.equal(aborted.manifest.finalTasks.t1.notes, "Halfway done");
  assert.equal(aborted.manifest.finalTasks.t2.status, "completed");
});

test("abort: backend can pass abortSignal through ctx without crashing", async () => {
  const dir = tempDir();
  setup(dir);

  // No abortSignal supplied — undefined should be fine.
  let saw;
  const outcome = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      saw = ctx.abortSignal;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "sess-noabort",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(saw, undefined, "abortSignal not provided");
  // no abort means normal flow runs (will exhaust since tasks not completed)
  assert.notEqual(outcome.summary.status, "aborted");
});
