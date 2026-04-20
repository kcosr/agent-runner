import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { ResumeError, resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { resetWorkspaceRun } from "../packages/core/dist/core/run/workspace-state.js";
import { completeAllTasksFromPrompt, withEnv } from "./helpers/runtime-paths.mjs";

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
cwd: repo-root
message: the-ask
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
---
Work on {{cwd}}. Plan at {{assignment_path}}.
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
        cliVars: cliVars ?? {},
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked during init");
        }),
        initialize: true,
        callerCwd: baseDir,
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

test("init: persists workspace seed and manifest without invoking the backend", async () => {
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
  assert.deepEqual(outcome.manifest.runtimeVars, {});
  assert.equal(outcome.manifest.cwd, join(dir, "repo-root"));
  assert.equal(outcome.manifest.repo, "unknown");

  assert.ok(!existsSync(outcome.assignmentPath), "workspace assignment.md is not generated");
  assert.ok(existsSync(join(outcome.workspaceDir, "assignment-seed.md")), "workspace seed exists");

  // brief is stored verbatim
  assert.ok(outcome.manifest.brief, "brief is set");
  assert.ok(outcome.manifest.brief.includes("Agent role instructions."));
  assert.ok(outcome.manifest.brief.includes(`Work on ${join(dir, "repo-root")}.`));
  assert.ok(outcome.manifest.brief.endsWith("the-ask"));
});

test("init freezes config-time env interpolation into manifest state and runtime var coercion", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "two",
    `---
schemaVersion: \${AGENT_SCHEMA:-1}
name: two
backend: claude
model: \${AGENT_MODEL}
timeoutSec: \${AGENT_TIMEOUT}
---
Agent role for \${AGENT_TARGET}.
`,
  );
  writeAssignment(
    dir,
    "two-work",
    `---
schemaVersion: \${ASSIGNMENT_SCHEMA:-1}
name: \${ASSIGNMENT_NAME}
maxRetries: \${MAX_RETRIES}
cwd: \${ASSIGNMENT_CWD}
message: \${MESSAGE_TEXT}
callerInstructions: Review \${CALLER_TARGET}
vars:
  retries:
    type: number
    default: \${DEFAULT_RETRIES}
tasks:
  - id: deploy
    title: Deploy \${TASK_TARGET}
    body: Ship {{retries}} to \${TASK_TARGET}.
---
Work on \${BODY_TARGET}.
`,
  );

  const outcome = await withEnv(
    {
      AGENT_MODEL: "claude-sonnet-4-6",
      AGENT_TIMEOUT: "120",
      AGENT_TARGET: "staging",
      ASSIGNMENT_NAME: "env-two-work",
      MAX_RETRIES: "4",
      ASSIGNMENT_CWD: "env-repo",
      MESSAGE_TEXT: "ship-it",
      CALLER_TARGET: "production",
      DEFAULT_RETRIES: "11",
      TASK_TARGET: "staging",
      BODY_TARGET: "env-repo",
    },
    () => initIn(dir),
  );

  assert.equal(outcome.manifest.model, "claude-sonnet-4-6");
  assert.equal(outcome.manifest.timeoutSec, 120);
  assert.equal(outcome.manifest.assignment?.name, "env-two-work");
  assert.equal(outcome.manifest.cwd, join(dir, "env-repo"));
  assert.equal(outcome.manifest.message, "ship-it");
  assert.equal(outcome.manifest.maxAttempts, 5);
  assert.equal(outcome.manifest.callerInstructions, "Review production");
  assert.equal(outcome.manifest.agent.instructions, "Agent role for staging.");
  assert.ok(outcome.manifest.brief.includes("Work on env-repo."));
  assert.equal(outcome.manifest.runtimeVars.retries, 11);
  assert.equal(outcome.manifest.finalTasks.deploy.title, "Deploy staging");
  assert.equal(outcome.manifest.finalTasks.deploy.body, "Ship 11 to staging.");
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
          cliVars: {},
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
          callerCwd: dir,
          stderr: () => {},
          stdout: () => {},
        });
      } finally {
        process.chdir(originalCwd);
      }
    });
  }, ResumeError);
});

test("execute-after-init: uses stored brief verbatim", async () => {
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
      completeAllTasksFromPrompt(ctx.prompt);
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
  assert.equal(second.manifest.brief, init.manifest.brief, "brief persists after execute");

  // The prompt sent to the backend is the stored brief verbatim.
  assert.equal(seenPrompt, init.manifest.brief);
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
    mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
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
  assert.equal(afterExec.brief, init.manifest.brief);
  assert.equal(afterExec.finalTasks.t1.status, "completed");
  assert.equal(afterExec.resetSeed.brief, init.manifest.brief);
  assert.equal(afterExec.resetSeed.finalTasks.t1.status, "pending");
  assert.equal(afterExec.resetSeed.finalTasks.t2.status, "pending");
  assert.ok(existsSync(join(init.workspaceDir, "attempts", "01.json")));

  const reset = resetWorkspaceRun(init.workspaceDir);
  assert.equal(reset.status, "initialized");
  assert.equal(reset.brief, init.manifest.brief);
  assert.equal(reset.finalTasks.t1.status, "pending");
  assert.equal(reset.finalTasks.t2.status, "pending");
  assert.equal(reset.sessionCount, 0);
  assert.deepEqual(reset.sessions, []);
  assert.deepEqual(reset.attemptRecords, []);
  assert.equal(reset.backendSessionId, null);
  assert.equal(existsSync(join(init.workspaceDir, "attempts")), false);
});

test("execute-after-init: missing brief is a hard error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);
  // Corrupt the manifest to drop brief
  const manifestPath = join(init.workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.brief = null;
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
