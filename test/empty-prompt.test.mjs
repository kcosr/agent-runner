import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { EmptyPromptError, runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { setTaskStatusesForPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-emptyprompt-"));
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

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

async function runIn(baseDir, agentName, opts = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
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

// Agent with empty body and nothing else — no assignment either. Used to
// exercise EmptyPromptError.
const EMPTY_EVERYTHING = `---
schemaVersion: 1
name: empty
backend: claude
model: claude-sonnet-4-6
---
`;

// Agent with empty body, used together with an assignment that has tasks but
// no body/message of its own.
const BODY_LESS_TASKS_AGENT = `---
schemaVersion: 1
name: body-less-tasks
backend: claude
model: claude-sonnet-4-6
---
`;

const BODY_LESS_TASKS_ASSIGNMENT = `---
schemaVersion: 1
name: body-less-tasks-work
maxRetries: 1
tasks:
  - id: t1
    title: Do it
---
`;

// Agent with empty body and no assignment (chat mode) — lets the tests exercise
// message-only prompt composition.
const EMPTY_BODY_NO_TASKS = `---
schemaVersion: 1
name: body-less
backend: claude
model: claude-sonnet-4-6
---
`;

test("empty-prompt: agent with empty body, no message, no tasks throws EmptyPromptError", async () => {
  const dir = tempDir();
  writeAgent(dir, "empty", EMPTY_EVERYTHING);

  await assert.rejects(
    () =>
      runIn(dir, "empty", {
        backend: mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
      }),
    EmptyPromptError,
  );
});

test("empty-prompt: message only (no body, no tasks) runs successfully with just the message", async () => {
  const dir = tempDir();
  writeAgent(dir, "body-less", EMPTY_BODY_NO_TASKS);

  let seenPrompt;
  const outcome = await runIn(dir, "body-less", {
    overrides: { message: "what is 2 plus 2?" },
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-msg",
        transcript: "4",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenPrompt, "what is 2 plus 2?");
});

test("empty-prompt: tasks only (no body, no message) runs with just the workflow", async () => {
  const dir = tempDir();
  writeAgent(dir, "body-less-tasks", BODY_LESS_TASKS_AGENT);
  writeAssignment(dir, "body-less-tasks-work", BODY_LESS_TASKS_ASSIGNMENT);

  let seenPrompt;
  const outcome = await runIn(dir, "body-less-tasks", {
    assignmentName: "body-less-tasks-work",
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-workflow",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(outcome.exitCode, 0);
  assert.ok(
    seenPrompt.startsWith("You are working through a task list"),
    "starts directly with workflow",
  );
  assert.ok(seenPrompt.includes("task set"));
  // No leading blank lines from a missing body
  assert.ok(!seenPrompt.startsWith("\n"));
});

test("empty-prompt: message + tasks (no body) composes workflow above message without stray whitespace", async () => {
  const dir = tempDir();
  writeAgent(dir, "body-less-tasks", BODY_LESS_TASKS_AGENT);
  writeAssignment(dir, "body-less-tasks-work", BODY_LESS_TASKS_ASSIGNMENT);

  let seenPrompt;
  const outcome = await runIn(dir, "body-less-tasks", {
    assignmentName: "body-less-tasks-work",
    overrides: { message: "focus on it" },
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-msg-workflow",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(
    seenPrompt.split("\n\n\n").length,
    1,
    "no triple newlines (i.e. no empty body placeholder)",
  );
  const msgIdx = seenPrompt.indexOf("focus on it");
  const workflowIdx = seenPrompt.indexOf("You are working through a task list");
  assert.ok(msgIdx >= 0);
  assert.ok(workflowIdx >= 0);
  assert.ok(workflowIdx < msgIdx, "workflow comes before message (message last)");
});
