import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v9.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v9-"));
}

function writeManifest(root, repo, runId, manifest) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return join(dir, "run.json");
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function outOfOrderCanonicalResetSeed() {
  const resetSeed = {};
  resetSeed.finalTasks = {};
  resetSeed.attachments = [];
  resetSeed.hookState = {};
  resetSeed.runtimeVars = {};
  resetSeed.brief = "brief";
  resetSeed.maxAttempts = 4;
  resetSeed.timeoutSec = 10;
  resetSeed.unrestricted = false;
  resetSeed.dependencyRunIds = [];
  resetSeed.pinned = false;
  resetSeed.note = null;
  resetSeed.name = null;
  resetSeed.message = null;
  resetSeed.lockedFields = [];
  resetSeed.cwd = "/repo";
  resetSeed.effort = null;
  resetSeed.model = null;
  resetSeed.backend = "claude";
  return resetSeed;
}

test("migrate-manifests-v9 script dry-runs promotions/repairs and reports canonical v9 no-ops", () => {
  const root = tempDir();
  const v8Path = writeManifest(root, "demo", "run-v8", {
    schemaVersion: 8,
    runId: "run-v8",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: "/tmp/demo/run-v8",
    assignmentPath: "/tmp/demo/run-v8/assignment-seed.md",
    resetSeed: {
      finalTasks: {},
      brief: "brief",
      maxAttempts: 4,
      model: null,
      effort: null,
      timeoutSec: 10,
      unrestricted: false,
      dependencyRunIds: [],
      name: null,
    },
  });
  const v9RepairPath = writeManifest(root, "demo", "run-v9-repair", {
    schemaVersion: 9,
    runId: "run-v9-repair",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: "/tmp/demo/run-v9-repair",
    assignmentPath: "/tmp/demo/run-v9-repair/assignment-seed.md",
    resetSeed: {
      finalTasks: {},
      brief: "brief",
      maxAttempts: 4,
      model: null,
      effort: null,
      timeoutSec: 10,
      unrestricted: false,
      dependencyRunIds: [],
      name: null,
    },
  });
  writeManifest(root, "demo", "run-v9", {
    schemaVersion: 9,
    runId: "run-v9",
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: join(root, "runs", "demo", "run-v9"),
    assignmentPath: join(root, "runs", "demo", "run-v9", "assignment-seed.md"),
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    resetSeed: outOfOrderCanonicalResetSeed(),
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(stdout, /DRY\s+.*run-v8\/run\.json/);
  assert.match(stdout, /DRY\s+.*run-v9-repair\/run\.json/);
  assert.match(stdout, /OK\s+.*run-v9\/run\.json: already canonical schemaVersion 9 state/);
  assert.equal(readManifest(v8Path).schemaVersion, 8);
  assert.equal(readManifest(v9RepairPath).schemaVersion, 9);
});

test("migrate-manifests-v9 script writes v8 hook-state upgrades", () => {
  const root = tempDir();
  const v8Path = writeManifest(root, "demo", "run-v8", {
    schemaVersion: 8,
    runId: "run-v8",
    backend: "claude",
    model: null,
    effort: null,
    repo: "demo",
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    lockedFields: [],
    dependencyRunIds: [],
    runtimeVars: {},
    brief: "Current brief",
    maxAttempts: 4,
    attachments: [],
    finalTasks: {},
    workspaceDir: "/legacy/demo/run-v8",
    assignmentPath: "/legacy/demo/run-v8/assignment-seed.md",
    resetSeed: {
      brief: "Seed brief",
      finalTasks: {},
      maxAttempts: 4,
      model: null,
      effort: null,
      timeoutSec: 10,
      unrestricted: false,
      dependencyRunIds: [],
      name: null,
    },
  });
  const validV9Path = writeManifest(root, "demo", "run-v9", {
    schemaVersion: 9,
    runId: "run-v9",
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: join(root, "runs", "demo", "run-v9"),
    assignmentPath: join(root, "runs", "demo", "run-v9", "assignment-seed.md"),
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    resetSeed: {
      backend: "claude",
      model: null,
      effort: null,
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      dependencyRunIds: [],
      unrestricted: false,
      timeoutSec: 10,
      maxAttempts: 4,
      brief: "brief",
      runtimeVars: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
  });

  const writeRun = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(writeRun, /WRITE\s+.*run-v8\/run\.json: promoted to schemaVersion 9/);
  assert.match(writeRun, /OK\s+.*run-v9\/run\.json: already canonical schemaVersion 9 state/);
  assert.deepEqual(readManifest(v8Path), {
    schemaVersion: 9,
    runId: "run-v8",
    backend: "claude",
    model: null,
    effort: null,
    repo: "demo",
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    lockedFields: [],
    dependencyRunIds: [],
    runtimeVars: {},
    brief: "Current brief",
    maxAttempts: 4,
    attachments: [],
    finalTasks: {},
    workspaceDir: join(root, "runs", "demo", "run-v8"),
    assignmentPath: join(root, "runs", "demo", "run-v8", "assignment-seed.md"),
    assignment: null,
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    resetSeed: {
      backend: "claude",
      model: null,
      effort: null,
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      dependencyRunIds: [],
      unrestricted: false,
      timeoutSec: 10,
      maxAttempts: 4,
      brief: "Seed brief",
      runtimeVars: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
  });
  assert.deepEqual(readManifest(validV9Path), {
    schemaVersion: 9,
    runId: "run-v9",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: join(root, "runs", "demo", "run-v9"),
    assignmentPath: join(root, "runs", "demo", "run-v9", "assignment-seed.md"),
    assignment: null,
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    resetSeed: {
      backend: "claude",
      model: null,
      effort: null,
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      dependencyRunIds: [],
      unrestricted: false,
      timeoutSec: 10,
      maxAttempts: 4,
      brief: "brief",
      runtimeVars: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
  });
});

test("migrate-manifests-v9 script filters to selected repo buckets", () => {
  const root = tempDir();
  const taskRunnerPath = writeManifest(root, "task-runner", "run-task-runner", {
    schemaVersion: 8,
    runId: "run-task-runner",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: "/tmp/task-runner",
    assignmentPath: "/tmp/task-runner/assignment-seed.md",
    resetSeed: {
      finalTasks: {},
      brief: "brief",
      maxAttempts: 4,
      model: null,
      effort: null,
      timeoutSec: 10,
      unrestricted: false,
      dependencyRunIds: [],
      name: null,
    },
  });
  const assistantPath = writeManifest(root, "assistant", "run-assistant", {
    schemaVersion: 8,
    runId: "run-assistant",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: "/tmp/assistant",
    assignmentPath: "/tmp/assistant/assignment-seed.md",
    resetSeed: {
      finalTasks: {},
      brief: "brief",
      maxAttempts: 4,
      model: null,
      effort: null,
      timeoutSec: 10,
      unrestricted: false,
      dependencyRunIds: [],
      name: null,
    },
  });

  const writeRun = execFileSync(
    "node",
    [SCRIPT_PATH, "--root", root, "--repo", "task-runner", "--write"],
    {
      encoding: "utf8",
    },
  );

  assert.match(writeRun, /WRITE\s+.*run-task-runner\/run\.json: promoted to schemaVersion 9/);
  assert.match(writeRun, /SKIP\s+.*run-assistant\/run\.json: repo bucket assistant not selected/);
  assert.deepEqual(readManifest(taskRunnerPath), {
    schemaVersion: 9,
    runId: "run-task-runner",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: join(root, "runs", "task-runner", "run-task-runner"),
    assignmentPath: join(root, "runs", "task-runner", "run-task-runner", "assignment-seed.md"),
    assignment: null,
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    resetSeed: {
      backend: "claude",
      model: null,
      effort: null,
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      dependencyRunIds: [],
      unrestricted: false,
      timeoutSec: 10,
      maxAttempts: 4,
      brief: "brief",
      runtimeVars: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
  });
  assert.deepEqual(readManifest(assistantPath), {
    schemaVersion: 8,
    runId: "run-assistant",
    backend: "claude",
    model: null,
    effort: null,
    cwd: "/repo",
    message: null,
    name: null,
    unrestricted: false,
    timeoutSec: 10,
    maxAttempts: 4,
    brief: "brief",
    runtimeVars: {},
    lockedFields: [],
    dependencyRunIds: [],
    attachments: [],
    finalTasks: {},
    workspaceDir: "/tmp/assistant",
    assignmentPath: "/tmp/assistant/assignment-seed.md",
    resetSeed: {
      finalTasks: {},
      brief: "brief",
      maxAttempts: 4,
      model: null,
      effort: null,
      timeoutSec: 10,
      unrestricted: false,
      dependencyRunIds: [],
      name: null,
    },
  });
});
