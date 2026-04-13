import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { readStatus } from "../packages/core/dist/core/commands/service.js";
import { ResumeError, resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { createRunEventCapture } from "./helpers/run-events.mjs";
import { assignmentPathFromPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const THREE_AGENT = `---
schemaVersion: 1
name: three
backend: claude
model: claude-sonnet-4-6
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
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("three", baseDir);
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
  });
}

test("resume: happy path — original blocks, resume completes, same workspace", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  // Session 0 — blocks on t2
  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
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
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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

test("resume: archived runs are rejected until unarchived", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-archived",
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    })),
  });

  await withSharedRuntimeEnv(dir, async () => {
    assert.equal(readStatus(first.runId).capabilities.canResume, true);
  });

  const manifestPath = join(first.workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.archivedAt = "2026-04-12T18:00:00.000Z";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await withSharedRuntimeEnv(dir, async () => {
    assert.equal(readStatus(first.runId).capabilities.canResume, false);
  });

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked for archived resumes");
        }),
        overrides: { message: "continue" },
        resume: target,
      }),
    (err) => err instanceof ResumeError && /cannot resume archived run/.test(err.message),
  );
});

test("resume: rejects a target already marked running", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      let plan = readFileSync(absPlan, "utf8");
      plan = editStatus(plan, "t1", "completed");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-running-guard",
        transcript: "partial",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const manifestPath = join(first.workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.status = "running";
  manifest.exitCode = null;
  manifest.endedAt = null;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked for already-running resumes");
        }),
        overrides: { message: "continue" },
        resume: target,
      }),
    (err) => err instanceof ResumeError && /already running/.test(err.message),
  );
});

test("resume: start refreshes the latest initialized task state before claiming running", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const initialized = await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("three", dir);
    const loadedAssignment = loadAssignmentConfig("three-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: "mock",
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
        initialize: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  const staleTarget = withSharedRuntimeEnv(dir, () => resolveResumeTarget(initialized.runId, dir));

  const initializedManifestPath = join(initialized.workspaceDir, "run.json");
  const initializedManifest = JSON.parse(readFileSync(initializedManifestPath, "utf8"));
  initializedManifest.finalTasks.t1.status = "completed";
  initializedManifest.tasksCompleted = 1;
  writeFileSync(initializedManifestPath, `${JSON.stringify(initializedManifest, null, 2)}\n`);

  let initializedPlan = readFileSync(initialized.assignmentPath, "utf8");
  initializedPlan = editStatus(initializedPlan, "t1", "completed");
  writeFileSync(initialized.assignmentPath, initializedPlan, "utf8");

  const resumed = await runIn(dir, {
    backend: mockBackend(async () => {
      let plan = readFileSync(initialized.assignmentPath, "utf8");
      plan = editStatus(plan, "t2", "completed");
      plan = editStatus(plan, "t3", "completed");
      writeFileSync(initialized.assignmentPath, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-init-refresh",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    resume: staleTarget,
  });

  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.manifest.status, "success");
  assert.equal(resumed.manifest.finalTasks.t1.status, "completed");
  assert.equal(resumed.manifest.finalTasks.t2.status, "completed");
  assert.equal(resumed.manifest.finalTasks.t3.status, "completed");
});

test("resume: non-completed tasks normalized to pending, notes preserved", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
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
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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
        sessionId: "sess-addtask-only",
        transcript: "all done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.exitCode, 0);

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
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

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
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

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
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

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
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
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
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

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  assert.equal(target.workspaceDir, first.workspaceDir);
  assert.equal(target.manifest.runId, first.runId);
});

test("resume: resolveResumeTarget throws for unknown slug", () => {
  const dir = tempDir();
  assert.throws(
    () => withSharedRuntimeEnv(dir, () => resolveResumeTarget("notarealid", dir)),
    ResumeError,
  );
});

// Resume override policy — runAgent-layer enforcement. The CLI layer
// in src/cli.ts rejects these flags earlier with flag-level messages,
// but these tests drive runAgent directly to cover the defense-in-depth
// check inside the run loop. A programmatic caller constructing
// RunOptions must not be able to bypass the manifest-canonical rule.

test("resume: runAgent rejects overrides.cwd (backend sessions are cwd-bound)", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  // Session 0 — complete happy path so we have a resumable terminal run.
  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      let plan = readFileSync(absPlan, "utf8");
      for (const id of ["t1", "t2", "t3"]) plan = editStatus(plan, id, "completed");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-cwd-test",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.manifest.status, "success");

  // Attempt a resume with --cwd — must throw ResumeError.
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  await assert.rejects(
    async () =>
      runIn(dir, {
        resume: target,
        overrides: { cwd: "/tmp/some-other-cwd", message: "continue" },
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked");
        }),
      }),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /--cwd cannot be combined with --resume-run/);
      assert.match(err.message, /bound to the cwd/);
      return true;
    },
  );
});

test("resume: runAgent rejects cliVars non-empty on resume", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      let plan = readFileSync(absPlan, "utf8");
      for (const id of ["t1", "t2", "t3"]) plan = editStatus(plan, id, "completed");
      writeFileSync(absPlan, plan, "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-vars-test",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  // Programmatic caller passes cliVars with content on resume —
  // currently a silent no-op because resume doesn't re-resolve vars.
  // runAgent must reject loudly.
  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    const loaded = loadAgentConfig("three", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        async () =>
          runAgent({
            loaded,
            cliVars: { forced: "value" },
            backend: mockBackend(async () => {
              throw new Error("backend should not be invoked");
            }),
            overrides: { message: "continue" },
            resume: target,
            stderr: () => {},
            stdout: () => {},
          }),
        (err) => {
          assert.ok(err instanceof ResumeError);
          assert.match(err.message, /--var cannot be combined with --resume-run/);
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("resume: text summary includes the resume-run hint with the run id", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const capture = createRunEventCapture();
  await withSharedRuntimeEnv(dir, async () => {
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
          const absPlan = assignmentPathFromPrompt(ctx.prompt);
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
        emitEvent: capture.emitEvent,
      });
      const stderr = capture.stderr();
      assert.ok(stderr.includes("To continue this run with a follow-up message:"));
      assert.ok(stderr.includes(`task-runner run --resume-run ${outcome.runId}`));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
