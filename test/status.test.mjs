import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { renderRunStatus, renderSystemStatus } from "../apps/cli/dist/commands/render.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { toRunDetail } from "../packages/core/dist/contracts/runs.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { deriveEffectiveStatus } from "../packages/core/dist/core/run/status.js";
import { setTaskStatusesForPrompt, sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const STATUS_AGENT = `---
schemaVersion: 1
name: status-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const STATUS_ASSIGNMENT = `---
schemaVersion: 1
name: status-work
maxRetries: 1
tasks:
  - id: t1
    title: First
  - id: t2
    title: Second
---
Work.
`;

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-status-"));
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

function withSharedRuntimeEnv(baseDir, fn) {
  return withEnv(sharedRuntimeEnv(baseDir), fn);
}

function runCliExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error("expected CLI to fail");
  } catch (err) {
    if (err.status === undefined) throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

async function runFresh(baseDir) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("status-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("status-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: loaded.config.backend,
          async invoke(ctx) {
            setTaskStatusesForPrompt(ctx.prompt, { t1: "completed", t2: "completed" });
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
        },
        overrides: { name: "status test" },
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("renderRunStatus prints the persisted run summary", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const text = renderRunStatus(toRunDetail({ manifest: outcome.manifest, isLive: false }));
  assert.match(text, new RegExp(`── run ${outcome.runId} ──`));
  assert.match(text, /Status: success/);
  assert.match(text, /Agent: status-agent/);
  assert.match(text, /Backend: claude \(claude-sonnet-4-6\)/);
  assert.match(text, /Name: status test/);
  assert.match(text, new RegExp(`Workspace: ${outcome.workspaceDir}`));
  assert.match(text, /Sessions: 1/);
  assert.match(text, /Tasks completed: 2\/2/);
  assert.match(text, /- t1 — First \[completed\]/);
  assert.match(text, /- t2 — Second \[completed\]/);
});

test("renderRunStatus shows note and pin metadata without printing the note body", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const text = renderRunStatus(
    toRunDetail({
      manifest: {
        ...outcome.manifest,
        note: "# Internal note\n\nDo not print this body.",
        pinned: true,
      },
      isLive: false,
    }),
  );

  assert.match(text, /Pinned: yes/);
  assert.match(text, /Note: present/);
  assert.doesNotMatch(text, /Do not print this body/);
});

test("deriveEffectiveStatus marks passive runs with in-progress tasks as running", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const effectiveStatus = deriveEffectiveStatus({
    ...outcome.manifest,
    backend: "passive",
    status: "initialized",
    finalTasks: {
      ...outcome.manifest.finalTasks,
      t1: {
        ...outcome.manifest.finalTasks.t1,
        status: "in_progress",
      },
    },
  });

  assert.equal(effectiveStatus, "running");
});

test("deriveEffectiveStatus marks passive runs with completed tasks and pending work as running", () => {
  const effectiveStatus = deriveEffectiveStatus({
    backend: "passive",
    status: "initialized",
    finalTasks: {
      t1: { status: "completed" },
      t2: { status: "pending" },
    },
  });

  assert.equal(effectiveStatus, "running");
});

test("deriveEffectiveStatus marks fully completed passive runs as success", () => {
  const effectiveStatus = deriveEffectiveStatus({
    backend: "passive",
    status: "initialized",
    finalTasks: {
      t1: { status: "completed" },
      t2: { status: "completed" },
    },
  });

  assert.equal(effectiveStatus, "success");
});

test("deriveEffectiveStatus marks passive runs with completed work and pending remainder as running", () => {
  const effectiveStatus = deriveEffectiveStatus({
    backend: "passive",
    status: "initialized",
    finalTasks: {
      t1: { status: "completed" },
      t2: { status: "pending" },
    },
  });

  assert.equal(effectiveStatus, "running");
});

test("deriveEffectiveStatus marks completed-and-blocked passive runs as blocked", () => {
  const effectiveStatus = deriveEffectiveStatus({
    backend: "passive",
    status: "initialized",
    finalTasks: {
      t1: { status: "completed" },
      t2: { status: "blocked" },
    },
  });

  assert.equal(effectiveStatus, "blocked");
});

test("deriveEffectiveStatus keeps passive runs with no tasks as initialized", () => {
  const effectiveStatus = deriveEffectiveStatus({
    backend: "passive",
    status: "initialized",
    finalTasks: {},
  });

  assert.equal(effectiveStatus, "initialized");
});

test("deriveEffectiveStatus preserves passive terminal error statuses", () => {
  for (const status of ["aborted", "error", "exhausted"]) {
    const effectiveStatus = deriveEffectiveStatus({
      backend: "passive",
      status,
      finalTasks: {
        t1: { status: "completed" },
      },
    });

    assert.equal(effectiveStatus, status);
  }
});

test("renderRunStatus shows the canonical-state note for running runs", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const runningDetail = toRunDetail({
    manifest: {
      ...outcome.manifest,
      status: "running",
      exitCode: null,
      endedAt: null,
    },
    isLive: true,
  });

  const text = renderRunStatus(runningDetail);
  assert.match(text, /canonical run\.json task state/);
});

test("renderRunStatus shows effective status separately from lifecycle status", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const detail = toRunDetail({
    manifest: {
      ...outcome.manifest,
      backend: "passive",
      status: "initialized",
      finalTasks: {
        ...outcome.manifest.finalTasks,
        t1: {
          ...outcome.manifest.finalTasks.t1,
          status: "in_progress",
        },
        t2: {
          ...outcome.manifest.finalTasks.t2,
          status: "pending",
        },
      },
      tasksCompleted: 0,
    },
    isLive: false,
  });

  const text = renderRunStatus(detail);
  assert.match(text, /Status: running/);
  assert.match(text, /Lifecycle status: initialized/);
  assert.match(text, /Drive this run externally:/);
  assert.match(text, /agent-runner run brief/);
});

test("renderRunStatus shows ready promotion and execution hints separately", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const initializedText = renderRunStatus(
    toRunDetail({
      manifest: {
        ...outcome.manifest,
        status: "initialized",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 0,
        totalSessionCount: 0,
        sessions: [],
        attemptRecords: [],
        backendSessionId: null,
      },
      isLive: false,
    }),
  );
  assert.match(initializedText, /To promote this run for execution:/);
  assert.match(initializedText, new RegExp(`agent-runner run ready ${outcome.runId}`));
  assert.doesNotMatch(
    initializedText,
    new RegExp(`agent-runner run --resume-run ${outcome.runId}`),
  );

  const readyText = renderRunStatus(
    toRunDetail({
      manifest: {
        ...outcome.manifest,
        status: "ready",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 0,
        totalSessionCount: 0,
        sessions: [],
        attemptRecords: [],
        backendSessionId: null,
      },
      isLive: false,
    }),
  );
  assert.match(readyText, /To execute this run:/);
  assert.match(readyText, new RegExp(`agent-runner run --resume-run ${outcome.runId}`));
});

test("renderSystemStatus prints embedded-mode environment details", () => {
  const text = renderSystemStatus({
    configDir: "/tmp/config",
    stateDir: "/tmp/state",
    hostMode: "embedded",
    connectUrl: null,
    daemon: null,
  });

  assert.equal(
    text,
    "Config dir: /tmp/config\nState dir: /tmp/state\nHost mode: embedded\nConnect URL: none\nDaemon: not connected\n",
  );
});

test("renderSystemStatus prints connected daemon details", () => {
  const text = renderSystemStatus({
    configDir: "/tmp/config",
    stateDir: "/tmp/state",
    hostMode: "daemon",
    connectUrl: "ws://127.0.0.1:4773/",
    daemon: {
      daemonInstanceId: "daemon-ab12cd",
      pid: 424242,
      listenUrl: "ws://127.0.0.1:4773/",
      version: "0.1.0",
      startedAt: "2026-04-18T19:43:54.599Z",
    },
  });

  assert.match(text, /Host mode: daemon/);
  assert.match(text, /Connect URL: ws:\/\/127\.0\.0\.1:4773\//);
  assert.match(text, /Daemon: connected/);
  assert.match(text, /Daemon listen URL: ws:\/\/127\.0\.0\.1:4773\//);
});

test("renderRunStatus shows archive metadata and the unarchive hint", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const archivedDetail = toRunDetail({
    manifest: {
      ...outcome.manifest,
      archivedAt: "2026-04-12T18:00:00.000Z",
    },
    isLive: false,
  });

  const text = renderRunStatus(archivedDetail);
  assert.match(text, /Archived: 2026-04-12T18:00:00.000Z/);
  assert.match(text, /agent-runner run unarchive/);
});

test("run status CLI reports unreadable manifest snapshots as clean unexpected failures", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const runJsonPath = join(outcome.workspaceDir, "run.json");
  chmodSync(runJsonPath, 0o000);

  try {
    const result = runCliExpectFail(["run", "status", outcome.runId], { cwd: dir });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /agent-runner:/);
  } finally {
    chmodSync(runJsonPath, 0o600);
  }
});

test("run status --field projects RunDetail fields and rejects removed manifest-only keys", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const projected = JSON.parse(
    execFileSync(
      "node",
      [CLI_PATH, "run", "status", outcome.runId, "--output-format", "json", "--field", "tasks"],
      {
        cwd: dir,
        env: { ...process.env, ...sharedRuntimeEnv(dir) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.equal(projected.tasks[0].id, "t1");

  const detail = JSON.parse(
    execFileSync("node", [CLI_PATH, "run", "status", outcome.runId, "--output-format", "json"], {
      cwd: dir,
      env: { ...process.env, ...sharedRuntimeEnv(dir) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal("assignmentPath" in detail, false);
  assert.equal("workspacePath" in detail.assignment, false);

  for (const [field, expected] of [
    ["effectiveStatus", "success"],
    ["totalAttemptCount", 1],
    ["maxAttemptsPerSession", 2],
    ["totalSessionCount", 1],
  ]) {
    const projectedField = JSON.parse(
      execFileSync(
        "node",
        [CLI_PATH, "run", "status", outcome.runId, "--output-format", "json", "--field", field],
        {
          cwd: dir,
          env: { ...process.env, ...sharedRuntimeEnv(dir) },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    assert.equal(projectedField[field], expected);
  }

  for (const field of ["attempts", "maxAttempts", "sessionCount", "finalTasks", "assignmentPath"]) {
    const failed = runCliExpectFail(
      ["run", "status", outcome.runId, "--output-format", "json", "--field", field],
      { cwd: dir },
    );
    assert.equal(failed.status, 3);
    assert.match(failed.stderr, new RegExp(`unknown status field\\(s\\): ${field}`));
  }
});

test("run status --field capabilities exposes the current run capability contract", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const projected = JSON.parse(
    execFileSync(
      "node",
      [
        CLI_PATH,
        "run",
        "status",
        outcome.runId,
        "--output-format",
        "json",
        "--field",
        "capabilities",
      ],
      {
        cwd: dir,
        env: { ...process.env, ...sharedRuntimeEnv(dir) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );

  assert.deepEqual(projected.capabilities, {
    canArchive: true,
    canUnarchive: false,
    canReset: true,
    canDelete: false,
    canReady: false,
    canResume: true,
    canAbort: false,
    abortReason: "already_terminal",
    canReconfigure: false,
    reconfigureReason: "not_initialized",
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
      canEditPending: true,
      canDeletePending: true,
    },
  });
  assert.equal("canMutateTasks" in projected.capabilities, false);
});

test("top-level status rejects unexpected run-id positionals", () => {
  const result = runCliExpectFail(["status", "abc123"]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /status takes no positional arguments/);
  assert.match(result.stderr, /Usage: agent-runner status \[--output-format text\|json\]/);
});

test("top-level status rejects --field", () => {
  const result = runCliExpectFail(["status", "--field", "configDir"]);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /status does not support --field/);
});

test("top-level status reports embedded environment details", () => {
  const dir = tempDir();
  const text = execFileSync("node", [CLI_PATH, "status"], {
    cwd: dir,
    env: { ...process.env, ...sharedRuntimeEnv(dir) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(text, new RegExp(`Config dir: ${dir}`));
  assert.match(text, new RegExp(`State dir: ${dir}`));
  assert.match(text, /Host mode: embedded/);
  assert.match(text, /Connect URL: none/);
  assert.match(text, /Daemon: not connected/);
});

test("top-level status --output-format json reports embedded environment details", () => {
  const dir = tempDir();
  const parsed = JSON.parse(
    execFileSync("node", [CLI_PATH, "status", "--output-format", "json"], {
      cwd: dir,
      env: { ...process.env, ...sharedRuntimeEnv(dir) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  assert.equal(parsed.configDir, dir);
  assert.equal(parsed.stateDir, dir);
  assert.equal(parsed.hostMode, "embedded");
  assert.equal(parsed.connectUrl, null);
  assert.equal(parsed.daemon, null);
});
