import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig } from "../dist/config/loader.js";
import { EmptyPromptError, runAgent } from "../dist/runner/run-loop.js";

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

async function runIn(baseDir, agentName, opts = {}) {
  const loaded = loadAgentConfig(agentName, baseDir);
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
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
}

const EMPTY_EVERYTHING = `---
schemaVersion: 1
name: empty
backend: claude
model: claude-sonnet-4-6
maxRetries: 1
---
`;

const EMPTY_BODY_WITH_TASKS = `---
schemaVersion: 1
name: body-less-tasks
backend: claude
model: claude-sonnet-4-6
maxRetries: 1
tasks:
  - id: t1
    title: Do it
---
`;

const EMPTY_BODY_NO_TASKS = `---
schemaVersion: 1
name: body-less
backend: claude
model: claude-sonnet-4-6
maxRetries: 1
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
  writeAgent(dir, "body-less-tasks", EMPTY_BODY_WITH_TASKS);

  let seenPrompt;
  const outcome = await runIn(dir, "body-less-tasks", {
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      const plan = readFileSync(absPlan, "utf8");
      writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
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
  assert.ok(seenPrompt.startsWith("Your assignment is at"), "starts directly with workflow");
  assert.ok(seenPrompt.includes("Set the task's **Status** to `in_progress`"));
  // No leading blank lines from a missing body
  assert.ok(!seenPrompt.startsWith("\n"));
});

test("empty-prompt: message + tasks (no body) composes message above workflow without stray whitespace", async () => {
  const dir = tempDir();
  writeAgent(dir, "body-less-tasks", EMPTY_BODY_WITH_TASKS);

  let seenPrompt;
  const outcome = await runIn(dir, "body-less-tasks", {
    overrides: { message: "focus on it" },
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      const plan = readFileSync(absPlan, "utf8");
      writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
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
  const workflowIdx = seenPrompt.indexOf("Your assignment is at");
  assert.ok(msgIdx >= 0);
  assert.ok(workflowIdx >= 0);
  assert.ok(msgIdx < workflowIdx);
});
