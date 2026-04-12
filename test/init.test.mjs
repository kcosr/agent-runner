import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { ResumeError, resolveResumeTarget } from "../dist/runner/manifest.js";
import { runAgent } from "../dist/runner/run-loop.js";
import { resetWorkspaceRun } from "../dist/runner/workspace-state.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

const TWO_AGENT = `---
schemaVersion: 1
name: two
backend: claude
model: claude-sonnet-4-6
---
Agent role instructions.
`;

const TWO_ASSIGNMENT = `---
schemaVersion: 1
name: two-work
maxRetries: 2
message: the-ask
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
---
Work on {{repo_path}}. Plan at {{assignment_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-init-"));
}

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "agent.md");
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

function writeAgentAndAssignment(baseDir) {
  writeAgent(baseDir, "two", TWO_AGENT);
  writeAssignment(baseDir, "two-work", TWO_ASSIGNMENT);
}

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${taskId}`);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

function withSharedRuntimeEnv(baseDir, fn) {
  return withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: baseDir,
      TASK_RUNNER_STATE_DIR: baseDir,
    },
    fn,
  );
}

async function initIn(baseDir, { cliVars, overrides } = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("two", baseDir);
    const loadedAssignment = loadAssignmentConfig("two-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: cliVars ?? { repo_path: "/tmp/fake-repo" },
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked during init");
        }),
        initialize: true,
        overrides,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

async function executeAfterInit(baseDir, runId, backend) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("two", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      const target = resolveResumeTarget(runId, baseDir);
      return await runAgent({
        loaded,
        cliVars: {},
        backend,
        resume: target,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("init: persists workspace, assignment.md, and manifest without invoking the backend", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await initIn(dir);

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.status, "initialized");
  assert.equal(outcome.manifest.status, "initialized");
  assert.equal(outcome.manifest.sessionCount, 0);
  assert.equal(outcome.manifest.sessions.length, 0);
  assert.equal(outcome.manifest.attemptRecords.length, 0);
  assert.equal(outcome.manifest.backendSessionId, null);
  assert.equal(outcome.manifest.tasksTotal, 2);
  assert.equal(outcome.manifest.runtimeVars.repo_path, "/tmp/fake-repo");

  // Assignment file exists and has task fences
  assert.ok(existsSync(outcome.assignmentPath), "workspace assignment.md exists");
  const planText = readFileSync(outcome.assignmentPath, "utf8");
  assert.ok(planText.includes("<!-- task-id: t1 -->"));
  assert.ok(planText.includes("<!-- task-id: t2 -->"));

  // pendingPrompt is stored verbatim
  assert.ok(outcome.manifest.pendingPrompt, "pendingPrompt is set");
  assert.ok(outcome.manifest.pendingPrompt.includes("Agent role instructions."));
  assert.ok(outcome.manifest.pendingPrompt.includes("Work on /tmp/fake-repo."));
  assert.ok(outcome.manifest.pendingPrompt.endsWith("the-ask"));
});

test("init: rejects --resume-run", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await initIn(dir);
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));

  await assert.rejects(async () => {
    await withSharedRuntimeEnv(dir, async () => {
      const loaded = loadAgentConfig("two", dir);
      const loadedAssignment = loadAssignmentConfig("two-work", dir);
      const originalCwd = process.cwd();
      process.chdir(dir);
      try {
        await runAgent({
          loaded,
          loadedAssignment,
          cliVars: { repo_path: "/tmp/other" },
          backend: mockBackend(async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: null,
            transcript: null,
            rawStdout: "",
            rawStderr: "",
          })),
          initialize: true,
          resume: target,
          stderr: () => {},
          stdout: () => {},
        });
      } finally {
        process.chdir(originalCwd);
      }
    });
  }, ResumeError);
});

test("execute-after-init: uses stored pendingPrompt verbatim", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);

  let seenPrompt;
  let seenResumeSessionId;
  const second = await executeAfterInit(
    dir,
    init.runId,
    mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      seenResumeSessionId = ctx.resumeSessionId;
      let plan = readFileSync(init.assignmentPath, "utf8");
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "completed");
      writeFileSync(init.assignmentPath, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-after-init",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  );

  assert.equal(second.exitCode, 0);
  assert.equal(second.runId, init.runId, "same runId");
  assert.equal(second.workspaceDir, init.workspaceDir, "same workspace");
  assert.equal(second.manifest.status, "success");
  // Session 0, not session 1 — init never created a session.
  assert.equal(second.manifest.sessionCount, 1);
  assert.equal(second.manifest.sessions.length, 1);
  assert.equal(second.manifest.sessions[0].sessionIndex, 0);
  assert.equal(second.manifest.sessions[0].backendSessionIdAtStart, null);
  assert.equal(second.manifest.pendingPrompt, null, "pendingPrompt cleared after execute");

  // The prompt sent to the backend is the stored pendingPrompt verbatim.
  assert.equal(seenPrompt, init.manifest.pendingPrompt);
  // No backend session id to resume from — session 0 starts fresh.
  assert.equal(seenResumeSessionId, undefined);
});

test("execute-after-init: reset seed survives execution and restores initialized state", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);
  await executeAfterInit(
    dir,
    init.runId,
    mockBackend(async () => {
      let plan = readFileSync(init.assignmentPath, "utf8");
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "completed");
      writeFileSync(init.assignmentPath, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-after-init",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  );

  const afterExec = JSON.parse(readFileSync(join(init.workspaceDir, "run.json"), "utf8"));
  assert.equal(afterExec.pendingPrompt, null);
  assert.equal(afterExec.finalTasks.t1.status, "completed");
  assert.equal(afterExec.resetSeed.pendingPrompt, init.manifest.pendingPrompt);
  assert.equal(afterExec.resetSeed.finalTasks.t1.status, "pending");
  assert.equal(afterExec.resetSeed.finalTasks.t2.status, "pending");
  assert.ok(existsSync(join(init.workspaceDir, "attempts", "01.json")));

  const reset = resetWorkspaceRun(init.workspaceDir);
  assert.equal(reset.status, "initialized");
  assert.equal(reset.pendingPrompt, init.manifest.pendingPrompt);
  assert.equal(reset.finalTasks.t1.status, "pending");
  assert.equal(reset.finalTasks.t2.status, "pending");
  assert.equal(reset.sessionCount, 0);
  assert.deepEqual(reset.sessions, []);
  assert.deepEqual(reset.attemptRecords, []);
  assert.equal(reset.backendSessionId, null);
  assert.equal(existsSync(join(init.workspaceDir, "attempts")), false);
});

test("execute-after-init: missing pendingPrompt is a hard error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);
  // Corrupt the manifest to drop pendingPrompt
  const manifestPath = join(init.workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.pendingPrompt = null;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  await assert.rejects(
    () =>
      executeAfterInit(
        dir,
        init.runId,
        mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "x",
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
      ),
    ResumeError,
  );
});

test("execute-after-init: --assignment is forbidden", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(init.runId, dir));

  await assert.rejects(async () => {
    await withSharedRuntimeEnv(dir, async () => {
      const loaded = loadAgentConfig("two", dir);
      const loadedAssignment = loadAssignmentConfig("two-work", dir);
      const originalCwd = process.cwd();
      process.chdir(dir);
      try {
        await runAgent({
          loaded,
          loadedAssignment,
          cliVars: {},
          backend: mockBackend(async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "x",
            transcript: null,
            rawStdout: "",
            rawStderr: "",
          })),
          resume: target,
          stderr: () => {},
          stdout: () => {},
        });
      } finally {
        process.chdir(originalCwd);
      }
    });
  }, ResumeError);
});

test("execute-after-init: --add-task is forbidden", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(init.runId, dir));

  await assert.rejects(async () => {
    await withSharedRuntimeEnv(dir, async () => {
      const loaded = loadAgentConfig("two", dir);
      const originalCwd = process.cwd();
      process.chdir(dir);
      try {
        await runAgent({
          loaded,
          cliVars: {},
          backend: mockBackend(async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "x",
            transcript: null,
            rawStdout: "",
            rawStderr: "",
          })),
          resume: target,
          overrides: { addedTasks: ["extra"] },
          stderr: () => {},
          stdout: () => {},
        });
      } finally {
        process.chdir(originalCwd);
      }
    });
  }, ResumeError);
});
