import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import {
  InvalidAddedTaskError,
  LockedFieldError,
  runAgent,
} from "../packages/core/dist/core/run/run-loop.js";
import {
  completeAllTasksFromPrompt,
  setTaskStatusesForPrompt,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

// ─── two-task assignment with an agent ──────────────────────────────────────
const TWO_AGENT = `---
schemaVersion: 1
name: two
backend: claude
model: claude-sonnet-4-6
---
Agent prompt.
`;

const TWO_ASSIGNMENT = `---
schemaVersion: 1
name: two-work
maxRetries: 1
tasks:
  - id: t1
    title: First
  - id: t2
    title: Second
---
Work on the repo. Assignment at {{cwd}}.
`;

// ─── chat-mode agent (no tasks, no assignment) ─────────────────────────────
const NO_TASKS = `---
schemaVersion: 1
name: notasks
backend: claude
model: claude-sonnet-4-6
---
Agent prompt.
`;

// ─── agent locks `tasks` (union locks; agent-side is fine) ─────────────────
const LOCKED_TASKS_AGENT = `---
schemaVersion: 1
name: locked-tasks
backend: claude
model: claude-sonnet-4-6
lockedFields: [tasks]
---
Agent prompt.
`;

const LOCKED_TASKS_ASSIGNMENT = `---
schemaVersion: 1
name: locked-tasks-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work on the repo. Assignment at {{cwd}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-addtask-"));
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

function setupTwo(dir) {
  writeAgent(dir, "two", TWO_AGENT);
  writeAssignment(dir, "two-work", TWO_ASSIGNMENT);
}

function setupLockedTasks(dir) {
  writeAgent(dir, "locked-tasks", LOCKED_TASKS_AGENT);
  writeAssignment(dir, "locked-tasks-work", LOCKED_TASKS_ASSIGNMENT);
}

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

async function runIn(baseDir, agentName, overrides, backend, assignmentName) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = assignmentName
      ? loadAssignmentConfig(assignmentName, baseDir)
      : undefined;
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend,
        overrides,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("add-task: CLI-added task is appended to the frontmatter list on fresh run", async () => {
  const dir = tempDir();
  setupTwo(dir);

  let seenIds;
  const outcome = await runIn(
    dir,
    "two",
    { addedTasks: ["Check the logs"] },
    mockBackend(async (ctx) => {
      seenIds = Object.keys(completeAllTasksFromPrompt(ctx.prompt).finalTasks);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-1",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    "two-work",
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.tasksTotal, 3);
  assert.equal(Object.keys(outcome.manifest.finalTasks).length, 3);
  assert.ok(seenIds.includes("t1"));
  assert.ok(seenIds.includes("t2"));
  const cliTaskId = seenIds.find((id) => id.startsWith("cli-"));
  assert.ok(cliTaskId, "cli-added task has cli- prefix");
  assert.equal(outcome.manifest.finalTasks[cliTaskId].title, "Check the logs");
  assert.equal(outcome.manifest.finalTasks[cliTaskId].status, "completed");
});

test("add-task: multiple added tasks preserve order", async () => {
  const dir = tempDir();
  setupTwo(dir);

  const outcome = await runIn(
    dir,
    "two",
    { addedTasks: ["First added", "Second added", "Third added"] },
    mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-order",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    "two-work",
  );

  assert.equal(outcome.manifest.tasksTotal, 5);
  const cliTasks = Object.values(outcome.manifest.finalTasks).filter((t) =>
    t.id.startsWith("cli-"),
  );
  assert.equal(cliTasks.length, 3);
  const titles = cliTasks.map((t) => t.title);
  assert.deepEqual(titles, ["First added", "Second added", "Third added"]);
});

test("add-task: works on resume — appends after task normalization", async () => {
  const dir = tempDir();
  setupTwo(dir);

  const first = await runIn(
    dir,
    "two",
    undefined,
    mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed", t2: "blocked" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-resume-2",
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    "two-work",
  );

  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    const loaded = loadAgentConfig("two", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const second = await runAgent({
        loaded,
        cliVars: {},
        backend: mockBackend(async (ctx) => {
          completeAllTasksFromPrompt(ctx.prompt);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "sess-resume-2",
            transcript: "done",
            rawStdout: "",
            rawStderr: "",
          };
        }),
        resume: target,
        overrides: {
          message: "try alternate approach",
          addedTasks: ["Try alternate path"],
        },
        stderr: () => {},
        stdout: () => {},
      });

      assert.equal(second.exitCode, 0);
      assert.equal(second.manifest.tasksTotal, 3);
      const cliTask = Object.values(second.manifest.finalTasks).find((t) =>
        t.id.startsWith("cli-"),
      );
      assert.ok(cliTask, "cli task exists in resume manifest");
      assert.equal(cliTask.title, "Try alternate path");
      assert.equal(second.manifest.finalTasks.t1.status, "completed");
      assert.equal(second.manifest.finalTasks.t2.status, "completed");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("add-task: frontmatter with no tasks and one --add-task runs successfully", async () => {
  const dir = tempDir();
  writeAgent(dir, "notasks", NO_TASKS);

  const outcome = await runIn(
    dir,
    "notasks",
    { addedTasks: ["Do the thing"] },
    mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-notasks",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    undefined,
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.tasksTotal, 1);
});

test("add-task: 0-task run succeeds with one backend invocation", async () => {
  const dir = tempDir();
  writeAgent(dir, "notasks", NO_TASKS);

  let invocations = 0;
  const outcome = await runIn(
    dir,
    "notasks",
    undefined,
    mockBackend(async () => {
      invocations++;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-empty",
        transcript: "hello back",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    undefined,
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.status, "success");
  assert.equal(outcome.manifest.tasksTotal, 0);
  assert.equal(outcome.manifest.tasksCompleted, 0);
  assert.equal(invocations, 1);
});

test("add-task: empty title rejected with InvalidAddedTaskError", async () => {
  const dir = tempDir();
  setupTwo(dir);

  await assert.rejects(
    () =>
      runIn(
        dir,
        "two",
        { addedTasks: ["  "] },
        mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
        "two-work",
      ),
    InvalidAddedTaskError,
  );
});

test("add-task: title over 200 chars rejected", async () => {
  const dir = tempDir();
  setupTwo(dir);
  const longTitle = "x".repeat(201);

  await assert.rejects(
    () =>
      runIn(
        dir,
        "two",
        { addedTasks: [longTitle] },
        mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
        "two-work",
      ),
    InvalidAddedTaskError,
  );
});

test("add-task: --add-task rejected when `tasks` is locked", async () => {
  const dir = tempDir();
  setupLockedTasks(dir);

  await assert.rejects(
    () =>
      runIn(
        dir,
        "locked-tasks",
        { addedTasks: ["try to sneak in"] },
        mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
        "locked-tasks-work",
      ),
    LockedFieldError,
  );
});

test("add-task: locked `tasks` still allows runs without --add-task", async () => {
  const dir = tempDir();
  setupLockedTasks(dir);

  const outcome = await runIn(
    dir,
    "locked-tasks",
    undefined,
    mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-locked",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    "locked-tasks-work",
  );
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.tasksTotal, 1);
});
