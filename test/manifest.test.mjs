import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";

const THREE_TASKS = `---
schemaVersion: 1
name: three
backend: claude
model: claude-sonnet-4-6
effort: medium
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
Agent prompt. Plan at {{plan_path}}.
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
  const loaded = loadAgentConfig("three", baseDir);
  const backend = { id: "mock", invoke: mockInvoke };
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    const outcome = await runAgent({
      loaded,
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
}

test("manifest: run.json is written and matches outcome.manifest", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  const outcome = await runWithMock(dir, async (ctx) => {
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
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
      assistantMessage: "all three done",
      rawStdout: "raw stdout text",
      rawStderr: "",
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
  assert.equal(onDisk.attemptRecords[0].rawStdout, "raw stdout text");
  assert.equal(onDisk.attemptRecords[0].assistantMessage, "all three done");
  assert.equal(onDisk.finalTasks.t1.status, "completed");
  assert.equal(onDisk.finalTasks.t1.notes, "first done");
  assert.equal(onDisk.finalTasks.t1.title, "First");
  assert.equal(onDisk.finalTasks.t1.body.trim(), "Do the first thing.");
  assert.deepEqual(onDisk, outcome.manifest);
});

test("manifest: attempt records snapshot state after each attempt", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let call = 0;
  const outcome = await runWithMock(dir, async (ctx) => {
    call++;
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
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
      assistantMessage: `attempt ${call}`,
      rawStdout: `raw ${call}`,
      rawStderr: "",
    };
  });

  assert.equal(outcome.exitCode, 0);
  const m = outcome.manifest;
  assert.equal(m.attempts, 2);
  assert.equal(m.attemptRecords.length, 2);

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
  writeAgent(dir, "three", THREE_TASKS);

  const outcome = await runWithMock(dir, async (ctx) => {
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
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
      assistantMessage: "hit a wall",
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
  writeAgent(dir, "three", THREE_TASKS);

  let call = 0;
  const outcome = await runWithMock(dir, async () => {
    call++;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      assistantMessage: `attempt ${call}`,
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
  writeAgent(dir, "three", THREE_TASKS);

  const outcome = await runWithMock(
    dir,
    async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
      const absPlan = `./${match[0]}`;
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
        assistantMessage: "done",
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
  writeAgent(dir, "three", THREE_TASKS);

  let call = 0;
  const outcome = await runWithMock(dir, async (ctx) => {
    call++;
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
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
      assistantMessage: `attempt ${call}`,
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
