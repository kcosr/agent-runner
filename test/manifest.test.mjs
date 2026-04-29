import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { updateTasksForPrompt, withEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

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
Work on the repo. Plan at {{cwd}}.
`;

const CODEX_AGENT = `---
schemaVersion: 1
name: three
backend: codex
---
Codex agent prompt.
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

async function runWithMock(baseDir, mockInvoke, overrides = {}) {
  const backend = { id: overrides.__backendId ?? "claude", invoke: mockInvoke };
  const { __backendId, ...runOverrides } = overrides;
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
        overrides: runOverrides,
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
    updateTasksForPrompt(ctx.prompt, {
      t1: { status: "completed", notes: "first done" },
      t2: { status: "completed" },
      t3: { status: "completed" },
    });
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
  assert.equal(onDisk.totalAttemptCount, 1);
  assert.equal(onDisk.maxAttemptsPerSession, 3);
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
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(outcome.manifest)));

  const logPath = join(outcome.workspaceDir, "attempts", "01.json");
  assert.ok(existsSync(logPath), "attempts/01.json exists");
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  assert.equal(log.schemaVersion, 2);
  assert.equal(log.runId, outcome.runId);
  assert.equal(log.attemptNumber, 1);
  assert.equal(log.attemptIndexInSession, 0);
  assert.equal(log.stdout, "");
  assert.equal(log.stderr, "raw stderr text");
});

test("manifest: current manifests missing parentRunId are rejected on resume", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await runWithMock(dir, async (ctx) => {
    updateTasksForPrompt(ctx.prompt, {
      t1: { status: "completed" },
      t2: { status: "completed" },
      t3: { status: "completed" },
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-legacy-lineage",
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    };
  });

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  Reflect.deleteProperty(manifest, "parentRunId");
  Reflect.deleteProperty(manifest, "runtimeVarSources");
  Reflect.deleteProperty(manifest.resetSeed, "parentRunId");
  Reflect.deleteProperty(manifest.resetSeed, "runtimeVarSources");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(
    () => withSharedRuntimeEnv(dir, () => resolveResumeTarget(outcome.runId, dir)),
    (err) => {
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("manifest: TASK_RUNNER_FULL_ATTEMPT_LOGS opt-in preserves stdout in attempt logs", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await withEnv({ TASK_RUNNER_FULL_ATTEMPT_LOGS: "yes" }, () =>
    runWithMock(dir, async (ctx) => {
      updateTasksForPrompt(ctx.prompt, {
        t1: { status: "completed" },
        t2: { status: "completed" },
        t3: { status: "completed" },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-full-log",
        transcript: "all three done with stdout",
        rawStdout: "raw stdout text",
        rawStderr: "raw stderr text",
      };
    }),
  );

  const log = JSON.parse(readFileSync(join(outcome.workspaceDir, "attempts", "01.json"), "utf8"));
  assert.equal(log.stdout, "raw stdout text");
  assert.equal(log.stderr, "raw stderr text");
});

test("manifest: attempt records capture attempt logs and session ids", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let call = 0;
  const outcome = await runWithMock(dir, async (ctx) => {
    call++;
    if (call === 1) {
      updateTasksForPrompt(ctx.prompt, { t1: { status: "completed" } });
    } else {
      updateTasksForPrompt(ctx.prompt, {
        t2: { status: "completed" },
        t3: { status: "completed" },
      });
    }
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
  assert.equal(m.totalAttemptCount, 2);
  assert.equal(m.attemptRecords.length, 2);

  assert.equal(m.attemptRecords[0].logPath, "attempts/01.json");
  assert.equal(m.attemptRecords[1].logPath, "attempts/02.json");
  const log1 = JSON.parse(readFileSync(join(outcome.workspaceDir, "attempts", "01.json"), "utf8"));
  const log2 = JSON.parse(readFileSync(join(outcome.workspaceDir, "attempts", "02.json"), "utf8"));
  assert.equal(log1.stdout, "");
  assert.equal(log2.stdout, "");
  assert.equal(log1.attemptNumber, 1);
  assert.equal(log2.attemptNumber, 2);

  assert.equal(m.attemptRecords[0].sessionIdAtStart, null);
  assert.equal(m.attemptRecords[0].sessionIdCaptured, "sess-multi");

  assert.equal(m.attemptRecords[1].sessionIdAtStart, "sess-multi");
});

test("manifest: blocked run records status and captures final state", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await runWithMock(dir, async (ctx) => {
    updateTasksForPrompt(ctx.prompt, {
      t1: { status: "in_progress", notes: "still investigating" },
      t2: { status: "blocked", notes: "could not reach the server" },
    });
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
  assert.equal(outcome.manifest.finalTasks.t1.status, "pending");
  assert.equal(outcome.manifest.finalTasks.t1.notes, "still investigating");
  assert.equal(outcome.manifest.finalTasks.t2.status, "blocked");
  assert.equal(outcome.manifest.finalTasks.t2.notes, "could not reach the server");
});

test("manifest: fresh runs persist the frozen launcher in run and reset seed state", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "three",
    `---
schemaVersion: 1
name: three
backend: claude
model: claude-sonnet-4-6
launcher: shared
---
Agent prompt.
`,
  );
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
name: shared
command: env
args: [LAUNCHER=1]
`,
  );

  const outcome = await runWithMock(dir, async (ctx) => {
    assert.deepEqual(ctx.launcher, {
      name: "shared",
      kind: "prefix",
      source: "named",
      command: "env",
      args: ["LAUNCHER=1"],
    });
    updateTasksForPrompt(ctx.prompt, {
      t1: { status: "completed" },
      t2: { status: "completed" },
      t3: { status: "completed" },
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-launcher",
      transcript: "launcher frozen",
      rawStdout: "",
      rawStderr: "",
    };
  });

  const onDisk = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
  assert.deepEqual(onDisk.launcher, {
    name: "shared",
    kind: "prefix",
    source: "named",
    command: "env",
    args: ["LAUNCHER=1"],
  });
  assert.deepEqual(onDisk.resetSeed.launcher, onDisk.launcher);
});

test("manifest: exhausted run records all attempts", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let call = 0;
  const outcome = await runWithMock(dir, async (ctx) => {
    call++;
    updateTasksForPrompt(ctx.prompt, {
      t1: { status: "in_progress", notes: `attempt ${call} in flight` },
    });
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
  assert.equal(outcome.manifest.totalAttemptCount, 3);
  assert.equal(outcome.manifest.attemptRecords.length, 3);
  assert.equal(outcome.manifest.tasksCompleted, 0);
  assert.equal(outcome.manifest.finalTasks.t1.status, "pending");
  assert.equal(outcome.manifest.finalTasks.t1.notes, "attempt 3 in flight");
});

test("manifest: thrown backend launch errors still settle the run as error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  await assert.rejects(
    async () => {
      await runWithMock(dir, async () => {
        const err = new Error("spawn claude ENOENT");
        err.code = "ENOENT";
        throw err;
      });
    },
    (error) => {
      assert.equal(error.message, "spawn claude ENOENT");
      assert.equal(error.code, "ENOENT");
      return true;
    },
  );

  const runsRoot = join(dir, "runs");
  const [repoDir] = readdirSync(runsRoot);
  const [runDir] = readdirSync(join(runsRoot, repoDir));
  const workspaceDir = join(runsRoot, repoDir, runDir);
  const manifestPath = join(workspaceDir, "run.json");
  const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.equal(onDisk.status, "error");
  assert.equal(onDisk.exitCode, 4);
  assert.match(onDisk.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(onDisk.totalAttemptCount, 1);
  assert.equal(onDisk.attemptRecords.length, 1);
  assert.equal(onDisk.sessions[0].status, "error");
  assert.equal(onDisk.sessions[0].firstAttemptNumber, 1);
  assert.equal(onDisk.sessions[0].lastAttemptNumber, 1);

  const log = JSON.parse(readFileSync(join(workspaceDir, "attempts", "01.json"), "utf8"));
  assert.equal(log.stdout, "");
  assert.match(log.stderr, /spawn claude ENOENT/);
});

test("manifest: captures effort override on the run metadata", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const outcome = await runWithMock(
    dir,
    async (ctx) => {
      updateTasksForPrompt(ctx.prompt, {
        t1: { status: "completed" },
        t2: { status: "completed" },
        t3: { status: "completed" },
      });
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

test("manifest: codex runs persist the stdio default transport in run metadata and reset seed", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const outcome = await withEnv({ TASK_RUNNER_CODEX_WS_URL: undefined }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        updateTasksForPrompt(ctx.prompt, {
          t1: { status: "completed" },
          t2: { status: "completed" },
          t3: { status: "completed" },
        });
        assert.deepEqual(ctx.backendSpecific, {
          codex: {
            transport: {
              type: "stdio",
            },
          },
        });
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
      { __backendId: "codex" },
    ),
  );

  const onDisk = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
  assert.deepEqual(onDisk.backendSpecific, {
    codex: {
      transport: {
        type: "stdio",
      },
    },
  });
  assert.deepEqual(onDisk.resetSeed.backendSpecific, onDisk.backendSpecific);
});

test("manifest: codex runs persist UDS transport in run metadata and reset seed", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const outcome = await withEnv(
    { TASK_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock", TASK_RUNNER_CODEX_WS_URL: undefined },
    () =>
      runWithMock(
        dir,
        async (ctx) => {
          updateTasksForPrompt(ctx.prompt, {
            t1: { status: "completed" },
            t2: { status: "completed" },
            t3: { status: "completed" },
          });
          assert.deepEqual(ctx.backendSpecific, {
            codex: {
              transport: {
                type: "uds",
                path: "/tmp/codex.sock",
              },
            },
          });
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
        { __backendId: "codex" },
      ),
  );

  const onDisk = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
  assert.deepEqual(onDisk.backendSpecific, {
    codex: {
      transport: {
        type: "uds",
        path: "/tmp/codex.sock",
      },
    },
  });
  assert.deepEqual(onDisk.resetSeed.backendSpecific, onDisk.backendSpecific);
});

test("manifest: malformed persisted UDS transport is rejected", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const outcome = await withEnv({ TASK_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock" }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        updateTasksForPrompt(ctx.prompt, {
          t1: { status: "completed" },
          t2: { status: "completed" },
          t3: { status: "completed" },
        });
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
      { __backendId: "codex" },
    ),
  );

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
  onDisk.backendSpecific.codex.transport.path = "relative.sock";
  writeFileSync(manifestPath, `${JSON.stringify(onDisk, null, 2)}\n`);

  assert.throws(
    () => withSharedRuntimeEnv(dir, () => resolveResumeTarget(outcome.runId, dir)),
    /does not look like a task-runner run\.json/,
  );
});
