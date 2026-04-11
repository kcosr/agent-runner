import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
effort: high
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
  return mkdtempSync(join(tmpdir(), "task-runner-run-"));
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

async function runWithMock(baseDir, mockInvoke, overrides = {}) {
  const loaded = loadAgentConfig("three", baseDir);
  const backend = {
    id: "mock",
    invoke: mockInvoke,
  };
  const stdoutChunks = [];
  const stderrChunks = [];
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    const outcome = await runAgent({
      loaded,
      cliVars: {},
      backend,
      overrides,
      stderr: (t) => stderrChunks.push(t),
      stdout: (t) => stdoutChunks.push(t),
    });
    return {
      outcome,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.chdir(originalCwd);
  }
}

test("effort level from frontmatter is forwarded to backend", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let seenEffort;
  const { outcome } = await runWithMock(dir, async (ctx) => {
    seenEffort = ctx.effort;
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
    let plan = readFileSync(absPlan, "utf8");
    plan = editStatus(plan, "t1", "completed");
    plan = editStatus(plan, "t2", "completed");
    plan = editStatus(plan, "t3", "completed");
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
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenEffort, "high");
});

test("effort override beats the frontmatter value", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let seenEffort;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenEffort = ctx.effort;
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
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
    { effort: "low" },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenEffort, "low");
});

test("happy path: mock marks all tasks completed in one attempt → exit 0", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let invocations = 0;
  const { outcome, stdout, stderr } = await runWithMock(dir, async (ctx) => {
    invocations++;
    const plan = readFileSync(`./${ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/)[0]}`, "utf8");
    let updated = plan;
    for (const id of ["t1", "t2", "t3"]) {
      updated = editStatus(updated, id, "completed");
    }
    writeFileSync(`./${ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/)[0]}`, updated, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-abc",
      transcript: "All done.",
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 1);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.status, "success");
  assert.equal(outcome.summary.tasksCompleted, 3);
  assert.equal(outcome.summary.attempts, 1);
  assert.ok(stderr.includes("── attempt 1 ──"), "divider on stderr");
  assert.ok(!stdout.includes("── attempt 1 ──"), "divider not on stdout");
  assert.ok(stderr.includes("Task results:"), "summary shows task results section");
  assert.ok(stderr.includes("Review "), "summary shows plan file review hint");
});

test("retry path: first attempt leaves one incomplete, second completes → exit 0", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let invocations = 0;
  let lastPrompt = "";
  const { outcome } = await runWithMock(dir, async (ctx) => {
    invocations++;
    lastPrompt = ctx.prompt;
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const planPath = match ? match[0] : null;
    const absPlan = planPath ? `./${planPath}` : null;
    if (!absPlan) throw new Error(`no plan path in prompt: ${ctx.prompt}`);

    const plan = readFileSync(absPlan, "utf8");
    let updated = plan;
    if (invocations === 1) {
      updated = editStatus(updated, "t1", "completed");
      updated = editStatus(updated, "t2", "completed");
      // leave t3 pending
    } else {
      updated = editStatus(updated, "t3", "completed");
    }
    writeFileSync(absPlan, updated, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-xyz",
      transcript: `attempt ${invocations} message`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 2);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.attempts, 2);
  assert.equal(outcome.attemptTranscripts.length, 2);
  assert.ok(lastPrompt.includes("Remaining tasks:"), "retry prompt should be the nudge");
  assert.ok(lastPrompt.includes("t3 (status: pending)"));
});

test("blocked path: marking one task blocked → exit 2, no further retries", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let invocations = 0;
  const { outcome } = await runWithMock(dir, async (ctx) => {
    invocations++;
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
    let plan = readFileSync(absPlan, "utf8");
    plan = editStatus(plan, "t1", "completed");
    plan = editStatus(plan, "t2", "blocked");
    // leave t3 pending
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

  assert.equal(invocations, 1, "should not retry when a task is blocked");
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.summary.status, "blocked");
  const blocked = outcome.summary.tasks.filter((t) => t.status === "blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, "t2");
});

test("exhausted path: never completes → exit 1 after maxRetries+1 attempts", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  let invocations = 0;
  const { outcome } = await runWithMock(dir, async () => {
    invocations++;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: `msg ${invocations}`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 3, "maxRetries=2 → 3 total attempts");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.summary.status, "exhausted");
  assert.equal(outcome.summary.attempts, 3);
});

test("session resume: first attempt session ID passed on retry", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  const seenResumeIds = [];
  let invocations = 0;
  const { outcome } = await runWithMock(dir, async (ctx) => {
    invocations++;
    seenResumeIds.push(ctx.resumeSessionId ?? null);
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
    const absPlan = `./${match[0]}`;
    let plan = readFileSync(absPlan, "utf8");
    if (invocations === 1) {
      plan = editStatus(plan, "t1", "completed");
    } else {
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
    }
    writeFileSync(absPlan, plan, "utf8");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-12345",
      transcript: `msg ${invocations}`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenResumeIds[0], null, "first attempt has no resume id");
  assert.equal(seenResumeIds[1], "sess-12345", "retry uses extracted session id");
});

test("resume failure falls back to fresh invocation", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_TASKS);

  const seenResumeIds = [];
  let invocations = 0;
  const { outcome, stderr } = await runWithMock(
    dir,
    async (ctx) => {
      invocations++;
      seenResumeIds.push(ctx.resumeSessionId ?? null);
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/tasks\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      if (invocations === 3) {
        plan = editStatus(plan, "t1", "completed");
        plan = editStatus(plan, "t2", "completed");
        plan = editStatus(plan, "t3", "completed");
      }
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: invocations === 2 ? 1 : 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-12345",
        transcript: `msg ${invocations}`,
        rawStdout: "",
        rawStderr: invocations === 2 ? "session not found" : "",
      };
    },
    { maxRetries: 3 },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenResumeIds[0], null);
  assert.equal(seenResumeIds[1], "sess-12345");
  assert.equal(seenResumeIds[2], null, "resume cleared after failure");
  assert.ok(stderr.includes("resume failed"));
});
