import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";

const STATUS_AGENT = `---
schemaVersion: 1
name: status-agent
backend: claude
model: claude-sonnet-4-6
maxRetries: 1
---
Agent.
`;

const STATUS_ASSIGNMENT = `---
schemaVersion: 1
name: status-work
sessionName: status test
tasks:
  - id: t1
    title: First
  - id: t2
    title: Second
---
Work.
`;

const CLI_PATH = resolvePath(new URL("../dist/cli.js", import.meta.url).pathname);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-status-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), body);
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assignment.md"), body);
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
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "completed");
      writeFileSync(absPlan, plan, "utf8");
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      sessionId: "sess-status-1",
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    };
  },
});

async function runFresh(baseDir) {
  const loaded = loadAgentConfig("status-agent", baseDir);
  const loadedAssignment = loadAssignmentConfig("status-work", baseDir);
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: {},
      backend: okBackend(),
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
}

function runCli(args, opts = {}) {
  const stdout = execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout;
}

test("status: text output shows run id, agent, status, tasks", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const text = runCli(["status", outcome.runId], { cwd: dir });
  assert.match(text, new RegExp(`── run ${outcome.runId} ──`));
  assert.match(text, /Status: success/);
  assert.match(text, /Agent: status-agent/);
  assert.match(text, /Backend: claude/);
  assert.match(text, /Session name: status test/);
  assert.match(text, /Tasks completed: 2\/2/);
  assert.match(text, /- t1 — First \[completed\]/);
  assert.match(text, /- t2 — Second \[completed\]/);
});

test("status: --output-format json prints the full manifest", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const out = runCli(["status", outcome.runId, "--output-format", "json"], { cwd: dir });
  const parsed = JSON.parse(out);
  assert.equal(parsed.runId, outcome.runId);
  assert.equal(parsed.status, "success");
  assert.equal(parsed.tasksCompleted, 2);
  assert.equal(parsed.sessionName, "status test");
  assert.ok(Array.isArray(parsed.attemptRecords));
});

test("status: --field projects to a subset of top-level fields", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const out = runCli(
    [
      "status",
      outcome.runId,
      "--output-format",
      "json",
      "--field",
      "status",
      "--field",
      "tasksCompleted",
      "--field",
      "sessionName",
    ],
    { cwd: dir },
  );
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed).sort(), ["sessionName", "status", "tasksCompleted"]);
  assert.equal(parsed.status, "success");
  assert.equal(parsed.tasksCompleted, 2);
  assert.equal(parsed.sessionName, "status test");
});

test("status: --field with text output is rejected", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  assert.throws(() => runCli(["status", outcome.runId, "--field", "status"], { cwd: dir }));
});

test("status: unknown --field name fails with exit 3", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  let caught;
  try {
    runCli(["status", outcome.runId, "--output-format", "json", "--field", "noSuchField"], {
      cwd: dir,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected runCli to throw");
  assert.equal(caught.status, 3);
});

test("status: missing positional fails", () => {
  const dir = tempDir();
  let caught;
  try {
    runCli(["status"], { cwd: dir });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected runCli to throw");
  assert.equal(caught.status, 3);
});

test("status: unknown run id fails with exit 3", () => {
  const dir = tempDir();
  let caught;
  try {
    runCli(["status", "doesnotexist"], { cwd: dir });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected runCli to throw");
  assert.equal(caught.status, 3);
});
