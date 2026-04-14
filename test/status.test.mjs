import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { renderRunStatus } from "../apps/cli/dist/commands/render.js";
import { parseAssignment } from "../packages/core/dist/assignment/parser.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { toRunDetail } from "../packages/core/dist/contracts/runs.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { applyLiveOverlay, deriveEffectiveStatus } from "../packages/core/dist/core/run/status.js";
import { assignmentPathFromPrompt, sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

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

function liveOverlay(rawAssignment) {
  return new Map(
    parseAssignment(rawAssignment).map((update) => [
      update.taskId,
      { status: update.status, notes: update.notes },
    ]),
  );
}

function withSharedRuntimeEnv(baseDir, fn) {
  return withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: baseDir,
      TASK_RUNNER_STATE_DIR: baseDir,
    },
    fn,
  );
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

const okBackend = () => ({
  id: "mock",
  async invoke(ctx) {
    const planPath = assignmentPathFromPrompt(ctx.prompt);
    let plan = readFileSync(planPath, "utf8");
    plan = editStatus(plan, "t1", "completed");
    plan = editStatus(plan, "t2", "completed");
    writeFileSync(planPath, plan, "utf8");
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
        backend: okBackend(),
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
  assert.match(text, new RegExp(`Assignment file: ${outcome.assignmentPath}`));
  assert.match(text, /Sessions: 1/);
  assert.match(text, /Tasks completed: 2\/2/);
  assert.match(text, /- t1 — First \[completed\]/);
  assert.match(text, /- t2 — Second \[completed\]/);
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

test("applyLiveOverlay updates tasksCompleted and finalTasks while manifest.status is running", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.tasksCompleted = 0;
    manifest.finalTasks.t1.status = "pending";
    manifest.finalTasks.t2.status = "pending";
  });

  const planPath = join(outcome.workspaceDir, "assignment.md");
  let plan = readFileSync(planPath, "utf8");
  plan = editStatus(plan, "t1", "completed");
  plan = editStatus(plan, "t2", "in_progress");
  writeFileSync(planPath, plan, "utf8");

  const overlaid = applyLiveOverlay(outcome.manifest, liveOverlay(plan));

  assert.equal(overlaid.status, "success", "overlay does not mutate the original manifest status");
  assert.equal(overlaid.tasksCompleted, 1);
  assert.equal(overlaid.finalTasks.t1.status, "completed");
  assert.equal(overlaid.finalTasks.t2.status, "in_progress");
});

test("applyLiveOverlay falls back to the manifest snapshot for invalid live statuses", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.finalTasks.t1.status = "pending";
  });

  const planPath = join(outcome.workspaceDir, "assignment.md");
  let plan = readFileSync(planPath, "utf8");
  plan = editStatus(plan, "t1", "in-progress");
  writeFileSync(planPath, plan, "utf8");

  const overlaid = applyLiveOverlay(outcome.manifest, liveOverlay(plan));
  assert.equal(overlaid.finalTasks.t1.status, "completed");
});

test("renderRunStatus shows the live-overlay note for running runs", async () => {
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
  assert.match(text, /read live from the workspace assignment\.md/);
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
  assert.match(text, /task-runner run unarchive/);
});

test("status CLI reports unreadable manifest snapshots as clean unexpected failures", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const runJsonPath = join(outcome.workspaceDir, "run.json");
  chmodSync(runJsonPath, 0o000);

  try {
    const result = runCliExpectFail(["status", outcome.runId], { cwd: dir });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /task-runner:/);
  } finally {
    chmodSync(runJsonPath, 0o600);
  }
});

test("status --field projects RunDetail fields and rejects removed manifest-only keys", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const projected = JSON.parse(
    execFileSync(
      "node",
      [CLI_PATH, "status", outcome.runId, "--output-format", "json", "--field", "tasks"],
      {
        cwd: dir,
        env: { ...process.env, ...sharedRuntimeEnv(dir) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.equal(projected.tasks[0].id, "t1");

  const effectiveStatus = JSON.parse(
    execFileSync(
      "node",
      [CLI_PATH, "status", outcome.runId, "--output-format", "json", "--field", "effectiveStatus"],
      {
        cwd: dir,
        env: { ...process.env, ...sharedRuntimeEnv(dir) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.equal(effectiveStatus.effectiveStatus, "success");

  const failed = runCliExpectFail(
    ["status", outcome.runId, "--output-format", "json", "--field", "finalTasks"],
    { cwd: dir },
  );
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /unknown status field\(s\): finalTasks/);
});

test("status --field capabilities exposes the current run capability contract", async () => {
  const dir = tempDir();
  writeAgent(dir, "status-agent", STATUS_AGENT);
  writeAssignment(dir, "status-work", STATUS_ASSIGNMENT);
  const outcome = await runFresh(dir);

  const projected = JSON.parse(
    execFileSync(
      "node",
      [CLI_PATH, "status", outcome.runId, "--output-format", "json", "--field", "capabilities"],
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
    canResume: true,
    canAbort: false,
    abortReason: "already_terminal",
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
  });
  assert.equal("canMutateTasks" in projected.capabilities, false);
});
