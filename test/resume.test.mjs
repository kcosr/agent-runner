import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { ResumeError, resolveResumeTarget } from "../dist/runner/manifest.js";
import { runAgent } from "../dist/runner/run-loop.js";

const THREE_AGENT = `---
schemaVersion: 1
name: three
backend: claude
model: claude-sonnet-4-6
maxRetries: 2
---
Agent prompt.
`;

const THREE_ASSIGNMENT = `---
schemaVersion: 1
name: three-work
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
  return mkdtempSync(join(tmpdir(), "task-runner-resume-"));
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
  if (start < 0) throw new Error(`marker not found: ${taskId}`);
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

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

async function runIn(baseDir, opts) {
  const loaded = loadAgentConfig("three", baseDir);
  // On resume, `--assignment` is forbidden; only pass loadedAssignment for
  // fresh runs.
  const loadedAssignment = opts.resume ? undefined : loadAssignmentConfig("three-work", baseDir);
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
}

test("resume: happy path — original blocks, resume completes, same workspace", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  // Session 0 — blocks on t2
  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "completed");
      plan = editStatus(plan, "t2", "blocked");
      plan = editNotes(plan, "t2", "db is down");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-original",
        transcript: "hit a wall",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(first.exitCode, 2);
  assert.equal(first.manifest.status, "blocked");
  assert.equal(first.manifest.sessionCount, 1);
  assert.equal(first.manifest.sessions.length, 1);
  assert.equal(first.manifest.sessions[0].status, "blocked");
  assert.equal(first.manifest.backendSessionId, "sess-original");

  // Resume — fix everything. Plan path is known from the first run.
  const firstPlanPath = join(first.workspaceDir, "assignment.md");
  const target = resolveResumeTarget(first.runId, dir);
  const second = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      // Should receive the inherited session id and only the follow-up message
      assert.equal(ctx.resumeSessionId, "sess-original");
      assert.equal(ctx.prompt, "db is back up");
      let plan = readFileSync(firstPlanPath, "utf8");
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
      writeFileSync(firstPlanPath, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-original",
        transcript: "fixed it",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    overrides: { message: "db is back up" },
    resume: target,
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.runId, first.runId, "same slug");
  assert.equal(second.workspaceDir, first.workspaceDir, "same workspace");
  assert.equal(second.manifest.status, "success");
  assert.equal(second.manifest.sessionCount, 2);
  assert.equal(second.manifest.sessions.length, 2);
  assert.equal(second.manifest.sessions[0].status, "blocked");
  assert.equal(second.manifest.sessions[1].status, "success");
  assert.equal(second.manifest.sessions[1].message, "db is back up");
  assert.equal(second.manifest.sessions[1].backendSessionIdAtStart, "sess-original");
});

test("resume: attempt numbers are monotonic across sessions", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  // Session 0 — exhausts (3 attempts, nothing changes)
  let calls = 0;
  const first = await runIn(dir, {
    backend: mockBackend(async () => {
      calls++;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-mono",
        transcript: `no-op ${calls}`,
        rawStdout: `raw ${calls}`,
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.manifest.attempts, 3);
  assert.equal(first.manifest.status, "exhausted");
  assert.equal(first.manifest.attemptRecords.at(-1).attempt, 3);

  // Resume — succeed on first attempt
  const firstPlanPath = join(first.workspaceDir, "assignment.md");
  const target = resolveResumeTarget(first.runId, dir);
  const second = await runIn(dir, {
    backend: mockBackend(async (_ctx) => {
      let plan = readFileSync(firstPlanPath, "utf8");
      for (const id of ["t1", "t2", "t3"]) {
        plan = editStatus(plan, id, "completed");
      }
      writeFileSync(firstPlanPath, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-mono",
        transcript: "done",
        rawStdout: "done raw",
        rawStderr: "",
      };
    }),
    overrides: { message: "try again" },
    resume: target,
  });

  assert.equal(second.manifest.attempts, 4);
  assert.equal(second.manifest.attemptRecords.length, 4);
  assert.equal(second.manifest.attemptRecords.at(-1).attempt, 4);
  assert.equal(second.manifest.attemptRecords.at(-1).sessionIndex, 1);
  assert.equal(second.manifest.attemptRecords[0].sessionIndex, 0);

  const log4 = JSON.parse(readFileSync(join(second.workspaceDir, "attempts", "04.json"), "utf8"));
  assert.equal(log4.attempt, 4);
  assert.equal(log4.sessionIndex, 1);
  assert.equal(log4.stdout, "done raw");
});

test("resume: non-completed tasks normalized to pending, notes preserved", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "completed");
      plan = editNotes(plan, "t1", "first done");
      plan = editStatus(plan, "t2", "blocked");
      plan = editNotes(plan, "t2", "blocked because X");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-norm",
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.manifest.status, "blocked");

  // Resume — inspect the in-memory state after normalization by reading tasks.md
  const firstPlanPath = join(first.workspaceDir, "assignment.md");
  const target = resolveResumeTarget(first.runId, dir);
  const second = await runIn(dir, {
    backend: mockBackend(async (_ctx) => {
      const plan = readFileSync(firstPlanPath, "utf8");

      // t1 stays completed
      assert.ok(plan.includes("<!-- task-id: t1 -->"));
      const t1Section = plan.slice(plan.indexOf("<!-- task-id: t1 -->"));
      assert.ok(t1Section.includes("**Status:** completed"), "t1 stays completed");
      assert.ok(t1Section.includes("first done"), "t1 notes preserved");

      // t2 normalized to pending but notes still there
      const t2Section = plan.slice(
        plan.indexOf("<!-- task-id: t2 -->"),
        plan.indexOf("<!-- task-id: t3 -->"),
      );
      assert.ok(t2Section.includes("**Status:** pending"), "t2 normalized from blocked to pending");
      assert.ok(t2Section.includes("blocked because X"), "t2 notes preserved");

      let updated = plan;
      updated = editStatus(updated, "t2", "completed");
      updated = editStatus(updated, "t3", "completed");
      writeFileSync(firstPlanPath, updated, "utf8");

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-norm",
        transcript: "recovered",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    overrides: { message: "try again with X resolved" },
    resume: target,
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.manifest.finalTasks.t1.status, "completed");
  assert.equal(second.manifest.finalTasks.t1.notes, "first done");
  assert.equal(second.manifest.finalTasks.t2.status, "completed");
});

test("resume: --add-task alone (no message) is allowed on resume", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
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
        sessionId: "sess-addtask-only",
        transcript: "all done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.exitCode, 0);

  const target = resolveResumeTarget(first.runId, dir);
  const firstPlanPath = join(first.workspaceDir, "assignment.md");
  let seenPrompt;
  const second = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      let plan = readFileSync(firstPlanPath, "utf8");
      const ids = [...plan.matchAll(/<!-- task-id:\s*(cli-[A-Za-z0-9]+)\s*-->/g)].map((m) => m[1]);
      for (const id of ids) {
        plan = editStatus(plan, id, "completed");
      }
      writeFileSync(firstPlanPath, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-addtask-only",
        transcript: "new tasks done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    overrides: { addedTasks: ["follow-up task"] },
    resume: target,
  });

  assert.equal(second.exitCode, 0);
  // The prompt should be ONLY the new-tasks reminder, no leading whitespace.
  assert.ok(seenPrompt.startsWith("(task-runner:"), "prompt starts with the reminder");
  assert.ok(seenPrompt.includes("1 new task has been added"));
  assert.ok(!seenPrompt.includes("\n\n\n"), "no triple newlines from empty message slot");
});

test("resume: missing both message and --add-task is a hard error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "blocked");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-no-msg",
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const target = resolveResumeTarget(first.runId, dir);
  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
        overrides: {},
        resume: target,
      }),
    ResumeError,
  );
});

test("resume: missing backend session id is a hard error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "blocked");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: null, // <-- no session id extracted
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.manifest.backendSessionId, null);

  const target = resolveResumeTarget(first.runId, dir);
  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: null,
          rawStdout: "",
          rawStderr: "",
        })),
        overrides: { message: "try again" },
        resume: target,
      }),
    ResumeError,
  );
});

test("resume: claude rejecting the resume on first attempt fails hard", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "blocked");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-expired",
        transcript: "stuck",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const target = resolveResumeTarget(first.runId, dir);
  const second = await runIn(dir, {
    backend: mockBackend(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: null,
      rawStdout: "",
      rawStderr: "session not found",
    })),
    overrides: { message: "retry" },
    resume: target,
  });

  assert.equal(second.exitCode, 4);
  assert.equal(second.manifest.status, "error");
  assert.equal(second.manifest.sessions.length, 2);
  assert.equal(second.manifest.sessions[1].status, "error");
});

test("resume: resolveResumeTarget finds the workspace by slug in cwd", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      const absPlan = `./${match[0]}`;
      let plan = readFileSync(absPlan, "utf8");
      for (const id of ["t1", "t2", "t3"]) plan = editStatus(plan, id, "completed");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-find",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const target = resolveResumeTarget(first.runId, dir);
  assert.equal(target.workspaceDir, first.workspaceDir);
  assert.equal(target.manifest.runId, first.runId);
});

test("resume: resolveResumeTarget throws for unknown slug", () => {
  const dir = tempDir();
  assert.throws(() => resolveResumeTarget("notarealid", dir), ResumeError);
});

test("resume: text summary includes the resume-run hint with the run id", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const stderrChunks = [];
  const loaded = loadAgentConfig("three", dir);
  const loadedAssignment = loadAssignmentConfig("three-work", dir);
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    const outcome = await runAgent({
      loaded,
      loadedAssignment,
      cliVars: {},
      backend: mockBackend(async (ctx) => {
        const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
        const absPlan = `./${match[0]}`;
        let plan = readFileSync(absPlan, "utf8");
        for (const id of ["t1", "t2", "t3"]) plan = editStatus(plan, id, "completed");
        writeFileSync(absPlan, plan, "utf8");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "sess-hint",
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      }),
      stderr: (t) => stderrChunks.push(t),
      stdout: () => {},
    });
    const stderr = stderrChunks.join("");
    assert.ok(stderr.includes("To continue this run with a follow-up message:"));
    assert.ok(stderr.includes(`task-runner run --resume-run ${outcome.runId}`));
  } finally {
    process.chdir(originalCwd);
  }
});
