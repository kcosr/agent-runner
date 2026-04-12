import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { LockedFieldError, runAgent } from "../dist/runner/run-loop.js";
import { assignmentPathFromPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

// ─── locked model agent + its one-task assignment ───────────────────────────
const LOCKED_MODEL_AGENT = `---
schemaVersion: 1
name: locked
backend: claude
model: claude-sonnet-4-6
effort: medium
lockedFields: [model, effort]
---
Agent prompt.
`;

const LOCKED_MODEL_ASSIGNMENT = `---
schemaVersion: 1
name: locked-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work on the repo. Plan at {{assignment_path}}.
`;

// ─── agent with default message on the assignment ───────────────────────────
const WITH_MSG_AGENT = `---
schemaVersion: 1
name: with-msg
backend: claude
model: claude-sonnet-4-6
---
Agent prompt.
`;

const WITH_MSG_ASSIGNMENT = `---
schemaVersion: 1
name: with-msg-work
maxRetries: 1
message: default message from frontmatter
tasks:
  - id: t1
    title: First
---
Work on the repo. Plan at {{assignment_path}}.
`;

// ─── agent that locks `message`; assignment carries the default value ──────
const LOCKED_MSG_AGENT = `---
schemaVersion: 1
name: locked-msg
backend: claude
model: claude-sonnet-4-6
lockedFields: [message]
---
Agent prompt.
`;

const LOCKED_MSG_ASSIGNMENT = `---
schemaVersion: 1
name: locked-msg-work
maxRetries: 1
message: fixed message
tasks:
  - id: t1
    title: First
---
Work on the repo. Plan at {{assignment_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-locked-"));
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

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

const okBackend = () => ({
  id: "mock",
  async invoke(ctx) {
    const absPlan = assignmentPathFromPrompt(ctx.prompt);
    if (absPlan) {
      const plan = readFileSync(absPlan, "utf8");
      writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    };
  },
});

async function runIn(baseDir, agentName, overrides, assignmentName) {
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
        backend: okBackend(),
        overrides,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function setupLockedModel(dir) {
  writeAgent(dir, "locked", LOCKED_MODEL_AGENT);
  writeAssignment(dir, "locked-work", LOCKED_MODEL_ASSIGNMENT);
}

function setupWithMsg(dir) {
  writeAgent(dir, "with-msg", WITH_MSG_AGENT);
  writeAssignment(dir, "with-msg-work", WITH_MSG_ASSIGNMENT);
}

function setupLockedMsg(dir) {
  writeAgent(dir, "locked-msg", LOCKED_MSG_AGENT);
  writeAssignment(dir, "locked-msg-work", LOCKED_MSG_ASSIGNMENT);
}

test("locked: overriding a locked field throws LockedFieldError", async () => {
  const dir = tempDir();
  setupLockedModel(dir);
  await assert.rejects(
    () => runIn(dir, "locked", { model: "claude-opus-4-6" }, "locked-work"),
    LockedFieldError,
  );
});

test("locked: overriding a non-locked field is fine", async () => {
  const dir = tempDir();
  setupLockedModel(dir);
  const outcome = await runIn(dir, "locked", { maxRetries: 5 }, "locked-work");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.model, "claude-sonnet-4-6");
});

test("locked: error message names the locked field and current value", async () => {
  const dir = tempDir();
  setupLockedModel(dir);
  await assert.rejects(
    () => runIn(dir, "locked", { effort: "max" }, "locked-work"),
    (err) => {
      assert.ok(err instanceof LockedFieldError);
      assert.equal(err.field, "effort");
      assert.ok(err.message.includes("effort"));
      assert.ok(err.message.includes('"medium"'));
      return true;
    },
  );
});

test("locked: schema rejects unknown lockable field names at load time", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "bad",
    `---
schemaVersion: 1
name: bad
backend: claude
lockedFields: [modle]
---
body
`,
  );
  withSharedRuntimeEnv(dir, () => {
    assert.throws(() => loadAgentConfig("bad", dir));
  });
});

test("message: default from assignment is used when no override", async () => {
  const dir = tempDir();
  setupWithMsg(dir);
  const outcome = await runIn(dir, "with-msg", undefined, "with-msg-work");
  assert.equal(outcome.manifest.message, "default message from frontmatter");
  const lastPrompt = outcome.manifest.attemptRecords[0].prompt;
  assert.ok(lastPrompt.includes("default message from frontmatter"));
});

test("message: CLI override beats assignment default when not locked", async () => {
  const dir = tempDir();
  setupWithMsg(dir);
  const outcome = await runIn(dir, "with-msg", { message: "caller override" }, "with-msg-work");
  assert.equal(outcome.manifest.message, "caller override");
  const lastPrompt = outcome.manifest.attemptRecords[0].prompt;
  assert.ok(lastPrompt.includes("caller override"));
  assert.ok(!lastPrompt.includes("default message from frontmatter"));
});

test("message: no override + no assignment default means null in manifest", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "plain",
    `---
schemaVersion: 1
name: plain
backend: claude
---
Plain agent.
`,
  );
  writeAssignment(
    dir,
    "plain-work",
    `---
schemaVersion: 1
name: plain-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work on the repo. Plan at {{assignment_path}}.
`,
  );
  const outcome = await runIn(dir, "plain", undefined, "plain-work");
  assert.equal(outcome.manifest.message, null);
});

test("message: locked message rejects caller override", async () => {
  const dir = tempDir();
  setupLockedMsg(dir);
  await assert.rejects(
    () => runIn(dir, "locked-msg", { message: "try to override" }, "locked-msg-work"),
    (err) => {
      assert.ok(err instanceof LockedFieldError);
      assert.equal(err.field, "message");
      return true;
    },
  );
});

test("message: locked message still uses the assignment default when caller stays silent", async () => {
  const dir = tempDir();
  setupLockedMsg(dir);
  const outcome = await runIn(dir, "locked-msg", undefined, "locked-msg-work");
  assert.equal(outcome.manifest.message, "fixed message");
});
