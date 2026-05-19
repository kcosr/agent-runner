import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import {
  completeAllTasksFromPrompt,
  setTaskStatusesForPrompt,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

const ONE_AGENT = `---
schemaVersion: 1
name: one
backend: claude
model: claude-sonnet-4-6
---
You are an assistant.
`;

const ONE_ASSIGNMENT = `---
schemaVersion: 1
name: one-work
maxRetries: 1
tasks:
  - id: t1
    title: Do it
---
`;

const ZERO_TASKS = `---
schemaVersion: 1
name: zero
backend: claude
model: claude-sonnet-4-6
---
You are a chat assistant.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-workflow-"));
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

function setupOne(dir) {
  writeAgent(dir, "one", ONE_AGENT);
  writeAssignment(dir, "one-work", ONE_ASSIGNMENT);
}

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

async function runIn(baseDir, agentName, opts = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    // Resume never accepts loadedAssignment; fresh runs load the named
    // assignment if the caller provided one.
    const loadedAssignment =
      !opts.resume && opts.assignmentName
        ? loadAssignmentConfig(opts.assignmentName, baseDir)
        : undefined;
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        overrides: opts.overrides,
        resume: opts.resume,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("workflow: fresh run with tasks injects the workflow template at end of body", async () => {
  const dir = tempDir();
  setupOne(dir);

  let seenPrompt;
  await runIn(dir, "one", {
    assignmentName: "one-work",
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
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
  });

  assert.ok(seenPrompt.includes("You are an assistant."), "body is present");
  assert.ok(seenPrompt.includes("You are working through a task list"), "workflow is present");
  assert.ok(seenPrompt.includes("task set"), "workflow steps present");
  assert.ok(seenPrompt.includes("task list"), "workflow mentions task commands");
  // Body should come before workflow
  const bodyIdx = seenPrompt.indexOf("You are an assistant.");
  const workflowIdx = seenPrompt.indexOf("You are working through a task list");
  assert.ok(bodyIdx < workflowIdx, "body comes before workflow");
});

test("workflow: fresh run with CLI message places message below body and workflow", async () => {
  const dir = tempDir();
  setupOne(dir);

  let seenPrompt;
  await runIn(dir, "one", {
    assignmentName: "one-work",
    overrides: { message: "focus on X right now" },
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-2",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const msgIdx = seenPrompt.indexOf("focus on X right now");
  const bodyIdx = seenPrompt.indexOf("You are an assistant.");
  const workflowIdx = seenPrompt.indexOf("You are working through a task list");
  assert.ok(msgIdx >= 0, "message present");
  assert.ok(bodyIdx >= 0, "body present");
  assert.ok(workflowIdx >= 0, "workflow present");
  assert.ok(bodyIdx < workflowIdx, "body comes before workflow");
  assert.ok(workflowIdx < msgIdx, "workflow comes before message (message last)");
});

test("workflow: fresh run with zero tasks does NOT inject workflow", async () => {
  const dir = tempDir();
  writeAgent(dir, "zero", ZERO_TASKS);

  let seenPrompt;
  const outcome = await runIn(dir, "zero", {
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-empty",
        transcript: "hi",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.tasksTotal, 0);
  assert.ok(seenPrompt.includes("You are a chat assistant."));
  assert.ok(
    !seenPrompt.includes("You are working through a task list"),
    "no workflow for 0-task run",
  );
  assert.ok(!seenPrompt.includes("task set"));
});

test("workflow: resume session does NOT re-inject workflow when prior sessions had tasks", async () => {
  const dir = tempDir();
  setupOne(dir);

  // Session 0 — block
  const first = await runIn(dir, "one", {
    assignmentName: "one-work",
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-resume-w",
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  // Resume — no --add-task, just a follow-up message
  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    let seenPrompt;
    await runIn(dir, "one", {
      resume: target,
      overrides: { message: "unblocked, try again" },
      backend: mockBackend(async (ctx) => {
        seenPrompt = ctx.prompt;
        const manifestPath = join(target.workspaceDir, "run.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.finalTasks.t1.status = "completed";
        manifest.tasksCompleted = 1;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "sess-resume-w",
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      }),
    });

    assert.equal(seenPrompt, "unblocked, try again");
    assert.ok(!seenPrompt.includes("You are working through a task list"));
    assert.ok(!seenPrompt.includes("new task"));
  });
});

test("workflow: resume session with --add-task and message keeps message last without added-task reminder", async () => {
  const dir = tempDir();
  setupOne(dir);

  const first = await runIn(dir, "one", {
    assignmentName: "one-work",
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-reminder",
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    let seenPrompt;
    await runIn(dir, "one", {
      resume: target,
      overrides: { message: "also do these", addedTasks: ["new one", "new two"] },
      backend: mockBackend(async (ctx) => {
        seenPrompt = ctx.prompt;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "sess-reminder",
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      }),
    });

    assert.ok(seenPrompt.includes("also do these"), "message present");
    assert.ok(
      !seenPrompt.includes("new tasks have been added to run"),
      "added-task reminder omitted",
    );
    assert.ok(
      !seenPrompt.includes("You are working through a task list"),
      "full workflow not re-injected",
    );
    assert.equal(seenPrompt, "also do these", "explicit message is not wrapped in reminders");
  });
});

test("workflow: resume session that introduces tasks for the first time injects full workflow", async () => {
  const dir = tempDir();
  writeAgent(dir, "zero", ZERO_TASKS);

  // Session 0 — zero tasks
  const first = await runIn(dir, "zero", {
    backend: mockBackend(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-first-tasks",
      transcript: "hi",
      rawStdout: "",
      rawStderr: "",
    })),
  });
  assert.equal(first.manifest.tasksTotal, 0);

  // Session 1 — add tasks via --add-task (first time tasks exist)
  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    let seenPrompt;
    const second = await runIn(dir, "zero", {
      resume: target,
      overrides: {
        message: "now please actually do this work",
        addedTasks: ["run date"],
      },
      backend: mockBackend(async (ctx) => {
        seenPrompt = ctx.prompt;
        completeAllTasksFromPrompt(ctx.prompt);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "sess-first-tasks",
          transcript: "ok",
          rawStdout: "",
          rawStderr: "",
        };
      }),
    });

    assert.equal(second.exitCode, 0);
    assert.ok(seenPrompt.includes("now please actually do this work"), "message present");
    assert.ok(seenPrompt.includes("You are working through a task list"), "full workflow present");
    assert.ok(seenPrompt.includes("task set"), "workflow steps present");
    assert.ok(
      !seenPrompt.includes("new tasks have been added since the last session"),
      "no 'new tasks' reminder (not a prior-had-tasks case)",
    );
    const msgIdx = seenPrompt.indexOf("now please actually do this work");
    const workflowIdx = seenPrompt.indexOf("You are working through a task list");
    assert.ok(workflowIdx < msgIdx, "workflow comes before message (message last)");
  });
});
