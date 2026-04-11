import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig } from "../dist/config/loader.js";
import { LockedFieldError, runAgent } from "../dist/runner/run-loop.js";

const THREE_TASKS_LOCKED_MODEL = `---
schemaVersion: 1
name: locked
backend: claude
model: claude-sonnet-4-6
effort: medium
lockedFields: [model, effort]
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Agent prompt. Plan at {{assignment_path}}.
`;

const WITH_DEFAULT_MESSAGE = `---
schemaVersion: 1
name: with-msg
backend: claude
model: claude-sonnet-4-6
message: default message from frontmatter
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Agent prompt. Plan at {{assignment_path}}.
`;

const LOCKED_MESSAGE = `---
schemaVersion: 1
name: locked-msg
backend: claude
model: claude-sonnet-4-6
message: fixed message
lockedFields: [message]
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Agent prompt. Plan at {{assignment_path}}.
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
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
    if (match) {
      const absPlan = `./${match[0]}`;
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

async function runIn(baseDir, agentName, overrides) {
  const loaded = loadAgentConfig(agentName, baseDir);
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
      cliVars: {},
      backend: okBackend(),
      overrides,
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
}

test("locked: overriding a locked field throws LockedFieldError", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked", THREE_TASKS_LOCKED_MODEL);
  await assert.rejects(() => runIn(dir, "locked", { model: "claude-opus-4-6" }), LockedFieldError);
});

test("locked: overriding a non-locked field is fine", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked", THREE_TASKS_LOCKED_MODEL);
  const outcome = await runIn(dir, "locked", { maxRetries: 5 });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.model, "claude-sonnet-4-6");
});

test("locked: error message names the locked field and current value", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked", THREE_TASKS_LOCKED_MODEL);
  await assert.rejects(
    () => runIn(dir, "locked", { effort: "max" }),
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
tasks:
  - id: t1
    title: First
---
body
`,
  );
  assert.throws(() => loadAgentConfig("bad", dir));
});

test("message: default from frontmatter is used when no override", async () => {
  const dir = tempDir();
  writeAgent(dir, "with-msg", WITH_DEFAULT_MESSAGE);
  const outcome = await runIn(dir, "with-msg", undefined);
  assert.equal(outcome.manifest.message, "default message from frontmatter");
  const lastPrompt = outcome.manifest.attemptRecords[0].prompt;
  assert.ok(lastPrompt.includes("default message from frontmatter"));
});

test("message: CLI override beats frontmatter default when not locked", async () => {
  const dir = tempDir();
  writeAgent(dir, "with-msg", WITH_DEFAULT_MESSAGE);
  const outcome = await runIn(dir, "with-msg", { message: "caller override" });
  assert.equal(outcome.manifest.message, "caller override");
  const lastPrompt = outcome.manifest.attemptRecords[0].prompt;
  assert.ok(lastPrompt.includes("caller override"));
  assert.ok(!lastPrompt.includes("default message from frontmatter"));
});

test("message: no override + no frontmatter default means null in manifest", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "plain",
    `---
schemaVersion: 1
name: plain
backend: claude
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Plain agent. Plan at {{assignment_path}}.
`,
  );
  const outcome = await runIn(dir, "plain", undefined);
  assert.equal(outcome.manifest.message, null);
});

test("message: locked message rejects caller override", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked-msg", LOCKED_MESSAGE);
  await assert.rejects(
    () => runIn(dir, "locked-msg", { message: "try to override" }),
    (err) => {
      assert.ok(err instanceof LockedFieldError);
      assert.equal(err.field, "message");
      return true;
    },
  );
});

test("message: locked message still uses the frontmatter default when caller stays silent", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked-msg", LOCKED_MESSAGE);
  const outcome = await runIn(dir, "locked-msg", undefined);
  assert.equal(outcome.manifest.message, "fixed message");
});
