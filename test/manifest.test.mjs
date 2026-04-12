import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/core/run/run-loop.js";
import { assignmentPathFromPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const THREE_AGENT = `---
schemaVersion: 1
name: three
backend: claude
model: claude-sonnet-4-6
effort: medium
---
Agent prompt.
`;

const THREE_ASSIGNMENT = `---
schemaVersion: 1
name: three-work
maxRetries: 2
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
  - id: t3
    title: Third
    body: Do the third thing.
---
Work on the repo. Plan at {{assignment_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-manifest-"));
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
  writeAgent(baseDir, "three", THREE_AGENT);
  writeAssignment(baseDir, "three-work", THREE_ASSIGNMENT);
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

function editNotes(content, taskId, notesText) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(
    /<!-- notes:start -->[\s\S]*?<!-- notes:end -->/,
    `<!-- notes:start -->\n${notesText}\n<!-- notes:end -->`,
  );
  return content.slice(0, start) + updated + content.slice(end);
}

async function runWithMock(baseDir, mockInvoke, overrides = {}) {
  const backend = { id: "mock", invoke: mockInvoke };
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("three", baseDir);
    const loadedAssignment = loadAssignmentConfig("three-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      const outcome = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend,
        overrides,
        stderr: () => {},
        stdout: () => {},
      });
      return outcome;
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("manifest: run.json is written and matches outcome.manifest", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await runWithMock(dir, async (ctx) => {
    const absPlan = assignmentPathFromPrompt(ctx.prompt);
    let plan = readFileSync(absPlan, "utf8");
    for (const id of ["t1", "t2", "t3"]) {
      plan = editStatus(plan, id, "completed");
    }
    plan = editNotes(plan, "t1", "first done");
    writeFileSync(absPlan, plan, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-abc-123",
      transcript: "all three done",
      rawStdout: "raw stdout text",
      rawStderr: "raw stderr text",
    };
  });

  const manifestPath = join(outcome.workspaceDir, "run.json");
  assert.ok(existsSync(manifestPath), "run.json exists in workspace");
  const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.equal(onDisk.status, "success");
  assert.equal(onDisk.exitCode, 0);
  assert.equal(onDisk.attempts, 1);
  assert.equal(onDisk.maxAttempts, 3);
  assert.equal(onDisk.tasksCompleted, 3);
  assert.equal(onDisk.tasksTotal, 3);
  assert.equal(onDisk.backendSessionId, "sess-abc-123");
  assert.equal(onDisk.agent.name, "three");
  assert.equal(onDisk.backend, "claude");
  assert.equal(onDisk.model, "claude-sonnet-4-6");
  assert.equal(onDisk.effort, "medium");
  assert.equal(onDisk.attemptRecords.length, 1);
  assert.equal(onDisk.attemptRecords[0].transcript, "all three done");
  assert.equal(onDisk.attemptRecords[0].logPath, "attempts/01.json");
  assert.equal(onDisk.attemptRecords[0].rawStdout, undefined, "no raw output in manifest");
  assert.equal(onDisk.finalTasks.t1.status, "completed");
  assert.equal(onDisk.finalTasks.t1.notes, "first done");
  assert.equal(onDisk.finalTasks.t1.title, "First");
  assert.equal(onDisk.finalTasks.t1.body.trim(), "Do the first thing.");
  assert.deepEqual(onDisk, outcome.manifest);

  const logPath = join(outcome.workspaceDir, "attempts", "01.json");
  assert.ok(existsSync(logPath), "attempts/01.json exists");
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  assert.equal(log.schemaVersion, 1);
  assert.equal(log.runId, outcome.runId);
  assert.equal(log.attempt, 1);
  assert.equal(log.stdout, "raw stdout text");
  assert.equal(log.stderr, "raw stderr text");
});

test("manifest: attempt records snapshot state after each attempt", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let call = 0;
  const outcome = await runWithMock(dir, async (ctx) => {
    call++;
    const absPlan = assignmentPathFromPrompt(ctx.prompt);
    let plan = readFileSync(absPlan, "utf8");
    if (call === 1) {
      plan = editStatus(plan, "t1", "completed");
    } else {
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
    }
    writeFileSync(absPlan, plan, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-multi",
      transcript: `attempt ${call}`,
      rawStdout: `raw ${call}`,
      rawStderr: "",
    };
  });

  assert.equal(outcome.exitCode, 0);
  const m = outcome.manifest;
  assert.equal(m.attempts, 2);
  assert.equal(m.attemptRecords.length, 2);

  assert.equal(m.attemptRecords[0].logPath, "attempts/01.json");
  assert.equal(m.attemptRecords[1].logPath, "attempts/02.json");
  const log1 = JSON.parse(readFileSync(join(outcome.workspaceDir, "attempts", "01.json"), "utf8"));
  const log2 = JSON.parse(readFileSync(join(outcome.workspaceDir, "attempts", "02.json"), "utf8"));
  assert.equal(log1.stdout, "raw 1");
  assert.equal(log2.stdout, "raw 2");
  assert.equal(log1.attempt, 1);
  assert.equal(log2.attempt, 2);

  assert.equal(m.attemptRecords[0].tasksAfter.t1.status, "completed");
  assert.equal(m.attemptRecords[0].tasksAfter.t2.status, "pending");
  assert.equal(m.attemptRecords[0].tasksAfter.t3.status, "pending");
  assert.equal(m.attemptRecords[0].sessionIdAtStart, null);
  assert.equal(m.attemptRecords[0].sessionIdCaptured, "sess-multi");

  assert.equal(m.attemptRecords[1].tasksAfter.t1.status, "completed");
  assert.equal(m.attemptRecords[1].tasksAfter.t2.status, "completed");
  assert.equal(m.attemptRecords[1].tasksAfter.t3.status, "completed");
  assert.equal(m.attemptRecords[1].sessionIdAtStart, "sess-multi");
});

test("manifest: blocked run records status and captures final state", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await runWithMock(dir, async (ctx) => {
    const absPlan = assignmentPathFromPrompt(ctx.prompt);
    let plan = readFileSync(absPlan, "utf8");
    plan = editStatus(plan, "t1", "completed");
    plan = editStatus(plan, "t2", "blocked");
    plan = editNotes(plan, "t2", "could not reach the server");
    writeFileSync(absPlan, plan, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: "hit a wall",
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(outcome.manifest.status, "blocked");
  assert.equal(outcome.manifest.exitCode, 2);
  assert.equal(outcome.manifest.finalTasks.t2.status, "blocked");
  assert.equal(outcome.manifest.finalTasks.t2.notes, "could not reach the server");
});

test("manifest: exhausted run records all attempts", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let call = 0;
  const outcome = await runWithMock(dir, async () => {
    call++;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: `attempt ${call}`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(outcome.manifest.status, "exhausted");
  assert.equal(outcome.manifest.exitCode, 1);
  assert.equal(outcome.manifest.attempts, 3);
  assert.equal(outcome.manifest.attemptRecords.length, 3);
  assert.equal(outcome.manifest.tasksCompleted, 0);
});

test("manifest: captures effort override on the run metadata", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await runWithMock(
    dir,
    async (ctx) => {
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      let plan = readFileSync(absPlan, "utf8");
      for (const id of ["t1", "t2", "t3"]) {
        plan = editStatus(plan, id, "completed");
      }
      writeFileSync(absPlan, plan, "utf8");
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
    { effort: "max" },
  );

  assert.equal(outcome.manifest.effort, "max");
});

test("manifest: invalid statuses are recorded on the attempt record", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let call = 0;
  const outcome = await runWithMock(dir, async (ctx) => {
    call++;
    const absPlan = assignmentPathFromPrompt(ctx.prompt);
    let plan = readFileSync(absPlan, "utf8");
    if (call === 1) {
      // write an invalid status on t1, real completed on t2/t3
      plan = plan.replace(/(<!-- task-id: t1 -->[\s\S]*?\*\*Status:\*\*) pending/, "$1 done");
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
    } else {
      // correct it
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
    }
    writeFileSync(absPlan, plan, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: `attempt ${call}`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(outcome.exitCode, 0);
  const first = outcome.manifest.attemptRecords[0];
  assert.equal(first.invalidStatuses.length, 1);
  assert.equal(first.invalidStatuses[0].taskId, "t1");
  assert.equal(first.invalidStatuses[0].rawValue, "done");

  const second = outcome.manifest.attemptRecords[1];
  assert.equal(second.invalidStatuses.length, 0);
});
