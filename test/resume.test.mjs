import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexBackend } from "../packages/core/dist/backends/codex.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { readStatus, readyRun, setTask } from "../packages/core/dist/core/commands/service.js";
import { ResumeError, resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { createRunEventCapture } from "./helpers/run-events.mjs";
import {
  completeAllTasksFromPrompt,
  setTaskStatusesForPrompt,
  updateTasksForPrompt,
  withEnv,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

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
Work on the repo. Plan at {{cwd}}.
`;

const CODEX_AGENT = `---
schemaVersion: 1
name: three
backend: codex
---
Agent prompt.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-resume-"));
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

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}${ext}`);
  writeFileSync(path, body);
  return path;
}

function writeAgentAndAssignment(baseDir) {
  writeAgent(baseDir, "three", THREE_AGENT);
  writeAssignment(baseDir, "three-work", THREE_ASSIGNMENT);
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function mockBackend(handler) {
  return { id: "mock", invoke: handler };
}

function codexMockBackend(invoke) {
  return {
    id: "codex",
    resolveConfig: codexBackend.resolveConfig,
    invoke,
  };
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

async function initIn(baseDir) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("three", baseDir);
    const loadedAssignment = loadAssignmentConfig("three-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked during init");
        }),
        initialize: true,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("resume: initialized runs reject until promoted to ready", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const init = await initIn(dir);
  const initialTarget = withSharedRuntimeEnv(dir, () => resolveResumeTarget(init.runId, dir));

  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => {
          throw new Error("backend should not run before ready");
        }),
        resume: initialTarget,
      }),
    (err) => err instanceof ResumeError && new RegExp(`run ready ${init.runId}`).test(err.message),
  );

  withSharedRuntimeEnv(dir, () => readyRun(init.runId));
  const readyTarget = withSharedRuntimeEnv(dir, () => resolveResumeTarget(init.runId, dir));
  const resumed = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-ready-start",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    resume: readyTarget,
  });

  assert.equal(resumed.manifest.status, "success");
});

test("resume: happy path — original blocks, resume completes, same workspace", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  // Session 0 — blocks on t2
  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      updateTasksForPrompt(ctx.prompt, {
        t1: { status: "completed" },
        t2: { status: "blocked", notes: "db is down" },
      });
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
  assert.equal(first.manifest.totalSessionCount, 1);
  assert.equal(first.manifest.sessions.length, 1);
  assert.equal(first.manifest.sessions[0].status, "blocked");
  assert.equal(first.manifest.backendSessionId, "sess-original");

  // Resume — fix everything. Plan path is known from the first run.
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  const second = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      // Should receive the inherited session id, the task reminder, and the follow-up message.
      assert.equal(ctx.resumeSessionId, "sess-original");
      assert.ok(
        ctx.prompt.includes(
          `inspect them with agent-runner task list ${first.runId} and use the task CLI`,
        ),
      );
      assert.ok(ctx.prompt.endsWith("db is back up"));
      patchManifest(first.workspaceDir, (manifest) => {
        manifest.finalTasks.t2.status = "completed";
        manifest.finalTasks.t3.status = "completed";
        manifest.tasksCompleted = 3;
      });
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
  assert.equal(second.manifest.totalSessionCount, 2);
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
  assert.equal(first.manifest.totalAttemptCount, 3);
  assert.equal(first.manifest.status, "exhausted");
  assert.equal(first.manifest.attemptRecords.at(-1).attemptNumber, 3);

  // Resume — succeed on first attempt
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  const second = await runIn(dir, {
    backend: mockBackend(async (_ctx) => {
      patchManifest(first.workspaceDir, (manifest) => {
        manifest.finalTasks.t1.status = "completed";
        manifest.finalTasks.t2.status = "completed";
        manifest.finalTasks.t3.status = "completed";
        manifest.tasksCompleted = 3;
      });
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

  assert.equal(second.manifest.totalAttemptCount, 4);
  assert.equal(second.manifest.attemptRecords.length, 4);
  assert.equal(second.manifest.attemptRecords.at(-1).attemptNumber, 4);
  assert.equal(second.manifest.attemptRecords.at(-1).sessionIndex, 1);
  assert.equal(second.manifest.attemptRecords[0].sessionIndex, 0);

  const log4 = JSON.parse(readFileSync(join(second.workspaceDir, "attempts", "04.json"), "utf8"));
  assert.equal(log4.attemptNumber, 4);
  assert.equal(log4.sessionIndex, 1);
  assert.equal("stdout" in log4, false);
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

test("resume: codex runs reuse the frozen transport instead of current env", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const initialTransport = {
    transport: {
      type: "ws",
      url: "ws://initial.example/socket",
    },
  };

  const first = await withEnv({ AGENT_RUNNER_CODEX_WS_URL: initialTransport.transport.url }, () =>
    runIn(dir, {
      backend: codexMockBackend(async (ctx) => {
        assert.deepEqual(ctx.backendConfig, initialTransport);
        updateTasksForPrompt(ctx.prompt, {
          t1: { status: "blocked", notes: "waiting on dependency" },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "thr-codex",
          transcript: "blocked",
          rawStdout: "",
          rawStderr: "",
        };
      }),
    }),
  );

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  const second = await withEnv({ AGENT_RUNNER_CODEX_WS_URL: "ws://changed.example/socket" }, () =>
    runIn(dir, {
      backend: codexMockBackend(async (ctx) => {
        assert.equal(ctx.resumeSessionId, "thr-codex");
        assert.deepEqual(ctx.backendConfig, initialTransport);
        patchManifest(first.workspaceDir, (manifest) => {
          manifest.finalTasks.t1.status = "completed";
          manifest.finalTasks.t2.status = "completed";
          manifest.finalTasks.t3.status = "completed";
          manifest.tasksCompleted = 3;
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "thr-codex",
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      }),
      overrides: { message: "dependency is back" },
      resume: target,
    }),
  );

  assert.deepEqual(second.manifest.backendConfig, initialTransport);
  assert.deepEqual(second.manifest.resetSeed.backendConfig, initialTransport);
});

test("resume: codex UDS runs reuse frozen transport and ignore env drift", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const initialTransport = {
    transport: {
      type: "uds",
      path: "/tmp/initial-codex.sock",
    },
  };

  const first = await withEnv(
    { AGENT_RUNNER_CODEX_UDS_PATH: initialTransport.transport.path },
    () =>
      runIn(dir, {
        backend: codexMockBackend(async (ctx) => {
          assert.deepEqual(ctx.backendConfig, initialTransport);
          updateTasksForPrompt(ctx.prompt, {
            t1: { status: "blocked", notes: "waiting on dependency" },
          });
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "thr-codex-uds",
            transcript: "blocked",
            rawStdout: "",
            rawStderr: "",
          };
        }),
      }),
  );

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  const second = await withEnv(
    {
      AGENT_RUNNER_CODEX_UDS_PATH: "/tmp/changed-codex.sock",
      AGENT_RUNNER_CODEX_WS_URL: "ws://changed.example/socket",
    },
    () =>
      runIn(dir, {
        backend: codexMockBackend(async (ctx) => {
          assert.equal(ctx.resumeSessionId, "thr-codex-uds");
          assert.deepEqual(ctx.backendConfig, initialTransport);
          patchManifest(first.workspaceDir, (manifest) => {
            manifest.finalTasks.t1.status = "completed";
            manifest.finalTasks.t2.status = "completed";
            manifest.finalTasks.t3.status = "completed";
            manifest.tasksCompleted = 3;
          });
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "thr-codex-uds",
            transcript: "done",
            rawStdout: "",
            rawStderr: "",
          };
        }),
        overrides: { message: "dependency is back" },
        resume: target,
      }),
  );

  assert.deepEqual(second.manifest.backendConfig, initialTransport);
  assert.deepEqual(second.manifest.resetSeed.backendConfig, initialTransport);
});

test("resume: rejects a target already marked running", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
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

  const initializedManifestPath = join(initialized.workspaceDir, "run.json");
  const initializedManifest = JSON.parse(readFileSync(initializedManifestPath, "utf8"));
  initializedManifest.finalTasks.t1.status = "completed";
  initializedManifest.tasksCompleted = 1;
  writeFileSync(initializedManifestPath, `${JSON.stringify(initializedManifest, null, 2)}\n`);
  withSharedRuntimeEnv(dir, () => readyRun(initialized.runId));
  const readyTarget = withSharedRuntimeEnv(dir, () => resolveResumeTarget(initialized.runId, dir));

  const resumed = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t2: "completed", t3: "completed" });
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
    resume: readyTarget,
  });

  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.manifest.status, "success");
  assert.equal(resumed.manifest.finalTasks.t1.status, "completed");
  assert.equal(resumed.manifest.finalTasks.t2.status, "completed");
  assert.equal(resumed.manifest.finalTasks.t3.status, "completed");
});

test("resume: blocked stays blocked while stale in_progress resets to pending", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
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
  assert.equal(first.manifest.status, "success");
  patchManifest(first.workspaceDir, (manifest) => {
    manifest.status = "blocked";
    manifest.exitCode = 2;
    manifest.finalTasks.t1.notes = "first done";
    manifest.finalTasks.t2.status = "blocked";
    manifest.finalTasks.t2.notes = "blocked because X";
    manifest.finalTasks.t3.status = "in_progress";
    manifest.finalTasks.t3.notes = "stale work claim";
    manifest.tasksCompleted = 1;
  });

  // Resume — inspect the in-memory state after normalization by reading tasks.md
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  const second = await runIn(dir, {
    backend: mockBackend(async (_ctx) => {
      const manifest = JSON.parse(readFileSync(join(first.workspaceDir, "run.json"), "utf8"));
      assert.equal(manifest.finalTasks.t1.status, "completed");
      assert.equal(manifest.finalTasks.t1.notes, "first done");
      assert.equal(manifest.finalTasks.t2.status, "blocked");
      assert.equal(manifest.finalTasks.t2.notes, "blocked because X");
      assert.equal(manifest.finalTasks.t3.status, "pending");
      assert.equal(manifest.finalTasks.t3.notes, "stale work claim");
      patchManifest(first.workspaceDir, (next) => {
        next.finalTasks.t2.status = "completed";
        next.finalTasks.t3.status = "completed";
        next.tasksCompleted = 3;
      });

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
      completeAllTasksFromPrompt(ctx.prompt);
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
  let seenPrompt;
  const second = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      seenPrompt = ctx.prompt;
      patchManifest(first.workspaceDir, (manifest) => {
        for (const task of Object.values(manifest.finalTasks)) {
          task.status = "completed";
        }
        manifest.tasksCompleted = Object.keys(manifest.finalTasks).length;
      });
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
  // The prompt should be ONLY the implicit continue message, no leading whitespace.
  assert.equal(seenPrompt, "Check the task list and continue working through the remaining items.");
  assert.ok(!seenPrompt.includes("\n\n\n"), "no triple newlines from empty message slot");
});

test("resume: unfinished tasks can resume with an implicit continue prompt", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" });
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
  const second = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      assert.ok(
        ctx.prompt.includes(
          `inspect them with agent-runner task list ${first.runId} and use the task CLI`,
        ),
      );
      assert.ok(
        ctx.prompt.endsWith(
          "Check the task list and continue working through the remaining items.",
        ),
      );
      patchManifest(first.workspaceDir, (manifest) => {
        manifest.finalTasks.t1.status = "completed";
        manifest.finalTasks.t2.status = "completed";
        manifest.finalTasks.t3.status = "completed";
        manifest.tasksCompleted = 3;
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-no-msg",
        transcript: "continued",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    overrides: {},
    resume: target,
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.manifest.status, "success");
  assert.equal(second.manifest.sessions.at(-1)?.message, null);
});

test("resume: terminal task status edits feed the existing implicit continue gate", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-terminal-edit",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });
  assert.equal(first.manifest.status, "success");

  await withSharedRuntimeEnv(dir, () => setTask(first.runId, "t1", { status: "pending" }));

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  const second = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      assert.ok(
        ctx.prompt.includes(
          `inspect them with agent-runner task list ${first.runId} and use the task CLI`,
        ),
      );
      assert.ok(
        ctx.prompt.endsWith(
          "Check the task list and continue working through the remaining items.",
        ),
      );
      patchManifest(first.workspaceDir, (manifest) => {
        manifest.finalTasks.t1.status = "completed";
        manifest.finalTasks.t2.status = "completed";
        manifest.finalTasks.t3.status = "completed";
        manifest.tasksCompleted = 3;
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-terminal-edit",
        transcript: "continued",
        rawStdout: "",
        rawStderr: "",
      };
    }),
    overrides: {},
    resume: target,
  });

  assert.equal(second.exitCode, 0);
  assert.equal(second.manifest.status, "success");
});

test("resume: blocked-only task state does not resume implicitly", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-blocked-only",
        transcript: "blocked",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  assert.equal(first.manifest.status, "success");
  patchManifest(first.workspaceDir, (manifest) => {
    manifest.status = "blocked";
    manifest.exitCode = 2;
    manifest.finalTasks.t1.status = "blocked";
    manifest.finalTasks.t1.notes = "waiting on approval";
    manifest.tasksCompleted = 2;
  });

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked");
        }),
        overrides: {},
        resume: target,
      }),
    (err) =>
      err instanceof ResumeError &&
      /no runnable tasks/.test(err.message) &&
      /follow-up message/.test(err.message),
  );
});

test("resume: missing both message and --add-task is still a hard error once all tasks are complete", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-all-done",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.runId, dir));
  await assert.rejects(
    () =>
      runIn(dir, {
        backend: mockBackend(async () => {
          throw new Error("backend should not be invoked");
        }),
        overrides: {},
        resume: target,
      }),
    (err) =>
      err instanceof ResumeError &&
      /no runnable tasks/.test(err.message) &&
      /follow-up message/.test(err.message),
  );
});

test("resume: missing backend session id is a hard error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" });
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
      setTaskStatusesForPrompt(ctx.prompt, { t1: "blocked" });
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
      completeAllTasksFromPrompt(ctx.prompt);
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
      completeAllTasksFromPrompt(ctx.prompt);
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

test("resume: runAgent rejects runtime vars on resume", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
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

  // Programmatic caller passes runtime vars with content on resume —
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
            webVars: {},
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
          assert.match(err.message, /runtime vars cannot be combined with --resume-run/);
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("resume: runAgent rejects web-authored runtime vars on resume", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      completeAllTasksFromPrompt(ctx.prompt);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-web-vars-test",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

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
            cliVars: {},
            webVars: { forced: "value" },
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
          assert.match(err.message, /runtime vars cannot be combined with --resume-run/);
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
          completeAllTasksFromPrompt(ctx.prompt);
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
      assert.ok(
        stderr.includes("To continue this run, provide a follow-up message or add a task:"),
      );
      assert.ok(stderr.includes(`agent-runner run --resume-run ${outcome.runId}`));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("resume reuses the frozen launcher instead of re-reading current launcher files", async () => {
  const dir = tempDir();
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: ssh
args: [initial-host]
`,
  );
  writeAgent(
    dir,
    "three",
    `---
schemaVersion: 1
name: three
backend: claude
launcher: shared
---
Agent prompt.
`,
  );
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const first = await runIn(dir, {
    backend: mockBackend(async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-original",
        transcript: "partial",
        rawStdout: "",
        rawStderr: "",
      };
    }),
  });

  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: ssh
args: [mutated-host]
`,
  );

  const second = await withSharedRuntimeEnv(dir, async () =>
    runIn(dir, {
      resume: resolveResumeTarget(first.runId, dir),
      overrides: { message: "finish it" },
      backend: mockBackend(async () => {
        patchManifest(first.workspaceDir, (manifest) => {
          for (const task of Object.values(manifest.finalTasks)) {
            task.status = "completed";
          }
          manifest.tasksCompleted = Object.keys(manifest.finalTasks).length;
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "sess-original",
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      }),
    }),
  );

  assert.deepEqual(second.manifest.launcher, {
    kind: "prefix",
    command: "ssh",
    args: ["initial-host"],
    name: "shared",
    source: "named",
  });
  assert.deepEqual(second.manifest.resetSeed.launcher, second.manifest.launcher);
});
