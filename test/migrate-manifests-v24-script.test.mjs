import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v24.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v24-"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeManifest(root, repo, runId, manifest) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "run.json");
  writeJson(manifestPath, { ...manifest, runId, repo, workspaceDir: dir });
  return manifestPath;
}

function baseV19Manifest(runId = "run-a") {
  return {
    schemaVersion: 19,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "codex",
    model: null,
    effort: null,
    resolvedBackendArgs: [],
    launcher: { kind: "direct", name: "direct" },
    message: null,
    name: null,
    note: null,
    pinned: false,
    unrestricted: false,
    cwd: "/repo",
    lockedFields: [],
    timeoutSec: 10,
    workspaceDir: "/state/run",
    startedAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "success",
    runGroupId: runId,
    dependencies: [],
    parentRunId: null,
    schedule: null,
    queuedResumeMessages: [],
    exitCode: 0,
    totalAttemptCount: 1,
    maxAttemptsPerSession: 3,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: null,
    backendSessionSync: null,
    runtimeVars: {},
    runtimeVarSources: {},
    execution: { hostMode: "embedded", controller: { kind: "embedded" } },
    brief: "brief",
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    callerInstructions: null,
    resetSeed: {
      backend: "codex",
      model: null,
      effort: null,
      resolvedBackendArgs: [],
      launcher: { kind: "direct", name: "direct" },
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      runGroupId: runId,
      dependencies: [],
      parentRunId: null,
      unrestricted: false,
      timeoutSec: 10,
      maxAttemptsPerSession: 3,
      brief: "brief",
      runtimeVars: {},
      runtimeVarSources: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
    attachments: [],
    finalTasks: {},
    totalSessionCount: 1,
    sessions: [
      {
        sessionIndex: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:01:00.000Z",
        status: "success",
        exitCode: 0,
        message: "brief",
        brief: "brief",
        firstAttemptNumber: 0,
        lastAttemptNumber: 0,
        maxAttemptsPerSession: 3,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "backend-session",
        provenance: { kind: "task_runner" },
      },
    ],
    attemptRecords: [
      {
        attemptNumber: 0,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:01:00.000Z",
        prompt: "brief",
        sessionIdAtStart: null,
        sessionIdCaptured: "backend-session",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "ok",
        logPath: "attempts/00.json",
        invalidStatuses: [],
        provenance: { kind: "task_runner" },
      },
    ],
  };
}

function managedEnvironment() {
  return {
    kind: "container",
    name: "feature-runtime",
    sourcePath: "/config/environments/feature-runtime.yaml",
    engine: "podman",
    cwd: "/workspace",
    env: {},
    extraExecArgs: [],
    lastValidatedAt: null,
    lastError: null,
    mode: "managed",
    image: "node:22",
    lifetime: "group",
    containerName: "agent-runner-group",
    containerId: null,
    workspace: {
      scope: "group",
      hostRoot: "/state/workspaces",
      hostPath: "/state/workspaces/group",
      containerPath: "/workspace",
      mode: "rw",
      create: true,
      createdAt: null,
      lifecycle: {
        onCreate: [
          {
            kind: "git-clone",
            source: "https://example.test/repo.git",
            baseRef: "origin/main",
            branch: "agent-runner/run-a",
          },
          {
            kind: "command",
            command: "npm",
            args: ["install"],
            env: { CI: "1" },
          },
        ],
        completedAt: "2026-05-06T00:00:00.000Z",
        lastError: null,
      },
    },
    sessionMounts: [
      {
        preset: "codex",
        hostPath: "/home/me/.codex",
        containerPath: "/home/me/.codex",
        mode: "rw",
      },
    ],
    mounts: [],
    network: "default",
    security: { capDrop: [], capAdd: [] },
    extraRunArgs: [],
    cleanup: { policy: "terminal", cleanedAt: null, lastError: null },
  };
}

test("migrate-manifests-v24 dry-runs v19 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV19Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 24/);
  assert.match(stdout, /SUMMARY migrated=1 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 19);
  assert.equal("executionEnvironment" in readJson(manifestPath), false);
});

test("migrate-manifests-v24 writes execution environment defaults for v19 manifests", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-ready", baseV19Manifest("run-ready"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-ready\/run\.json: promoted to schemaVersion 24/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 24);
  assert.equal(manifest.executionEnvironment, null);
  assert.equal(manifest.resetSeed.executionEnvironment, null);
});

test("migrate-manifests-v24 converts legacy workspace lifecycle to top-level lifecycle", () => {
  const root = tempDir();
  const environment = managedEnvironment();
  const manifestPath = writeManifest(root, "demo", "run-env", {
    ...baseV19Manifest("run-env"),
    schemaVersion: 23,
    executionEnvironment: environment,
    resetSeed: {
      ...baseV19Manifest("run-env").resetSeed,
      executionEnvironment: environment,
    },
  });

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], { encoding: "utf8" });

  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 24);
  assert.equal("lifecycle" in manifest.executionEnvironment.workspace, false);
  assert.equal(manifest.executionEnvironment.lifecycle.afterStart, null);
  assert.deepEqual(manifest.executionEnvironment.lifecycle.onWorkspaceCreate, {
    steps: [
      {
        kind: "git-clone",
        target: "container",
        source: "https://example.test/repo.git",
        baseRef: "origin/main",
        branch: "agent-runner/run-a",
        timeoutMs: null,
      },
      {
        kind: "command",
        target: "container",
        command: "npm",
        args: ["install"],
        env: { CI: "1" },
        cwd: null,
        timeoutMs: null,
        user: null,
        detach: false,
      },
    ],
    completedAt: "2026-05-06T00:00:00.000Z",
    lastError: null,
  });
  assert.equal("lifecycle" in manifest.resetSeed.executionEnvironment.workspace, false);
  assert.equal(
    manifest.resetSeed.executionEnvironment.lifecycle.onWorkspaceCreate.completedAt,
    "2026-05-06T00:00:00.000Z",
  );
});

test("migrate-manifests-v24 adds missing managed sessionMounts and lifecycle for v22 manifests", () => {
  const root = tempDir();
  const environment = managedEnvironment();
  environment.workspace.lifecycle = undefined;
  environment.sessionMounts = undefined;
  const manifestPath = writeManifest(root, "demo", "run-env", {
    ...baseV19Manifest("run-env"),
    schemaVersion: 22,
    executionEnvironment: environment,
    resetSeed: {
      ...baseV19Manifest("run-env").resetSeed,
      executionEnvironment: environment,
    },
  });

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], { encoding: "utf8" });

  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 24);
  assert.deepEqual(manifest.executionEnvironment.sessionMounts, []);
  assert.equal(manifest.executionEnvironment.lifecycle, null);
});

test("migrate-manifests-v24 rejects malformed converted lifecycle steps", () => {
  const root = tempDir();
  const environment = managedEnvironment();
  environment.workspace.lifecycle.onCreate[0].source = undefined;
  const manifestPath = writeManifest(root, "demo", "run-bad-lifecycle", {
    ...baseV19Manifest("run-bad-lifecycle"),
    schemaVersion: 23,
    executionEnvironment: environment,
    resetSeed: {
      ...baseV19Manifest("run-bad-lifecycle").resetSeed,
      executionEnvironment: environment,
    },
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /schemaVersion 24 executionEnvironment\.lifecycle\.onWorkspaceCreate git-clone lifecycle step is invalid/,
  );
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 23);
  assert.equal("lifecycle" in manifest.executionEnvironment.workspace, true);
});

test("migrate-manifests-v24 reports canonical v24 manifests as no-op", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v24", {
    ...baseV19Manifest("run-v24"),
    schemaVersion: 24,
    executionEnvironment: null,
    resetSeed: {
      ...baseV19Manifest("run-v24").resetSeed,
      executionEnvironment: null,
    },
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v24\/run\.json: already canonical schemaVersion 24/);
  assert.match(stdout, /SUMMARY migrated=0 conversionErrors=0/);
});

test("migrate-manifests-v24 reports dry-run repairs separately from promotion", () => {
  const root = tempDir();
  const manifest = {
    ...baseV19Manifest("run-v24-dry-repair"),
    schemaVersion: 24,
    executionEnvironment: null,
    resetSeed: {
      ...baseV19Manifest("run-v24-dry-repair").resetSeed,
      executionEnvironment: null,
    },
  };
  manifest.runtimeVarSources = undefined;
  manifest.resetSeed.runtimeVarSources = undefined;
  const manifestPath = writeManifest(root, "demo", "run-v24-dry-repair", manifest);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], {
    encoding: "utf8",
  });

  assert.match(
    stdout,
    /DRY\s+runs\/demo\/run-v24-dry-repair\/run\.json: would repair canonical schemaVersion 24 \(runtimeVarSources, resetSeed\.runtimeVarSources\)/,
  );
  assert.equal(readJson(manifestPath).runtimeVarSources, undefined);
});

test("migrate-manifests-v24 repairs v24 manifests missing runtime var source maps", () => {
  const root = tempDir();
  const manifest = {
    ...baseV19Manifest("run-v24-repair"),
    schemaVersion: 24,
    executionEnvironment: null,
    resetSeed: {
      ...baseV19Manifest("run-v24-repair").resetSeed,
      executionEnvironment: null,
    },
  };
  manifest.runtimeVarSources = undefined;
  manifest.resetSeed.runtimeVarSources = undefined;
  const manifestPath = writeManifest(root, "demo", "run-v24-repair", manifest);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(
    stdout,
    /WRITE\s+runs\/demo\/run-v24-repair\/run\.json: repaired canonical schemaVersion 24 \(runtimeVarSources, resetSeed\.runtimeVarSources\)/,
  );
  const migrated = readJson(manifestPath);
  assert.deepEqual(migrated.runtimeVarSources, {});
  assert.deepEqual(migrated.resetSeed.runtimeVarSources, {});
});

test("migrate-manifests-v24 repairs v24 manifests missing parent run ids", () => {
  const root = tempDir();
  const manifest = {
    ...baseV19Manifest("run-v24-parent-repair"),
    schemaVersion: 24,
    executionEnvironment: null,
    resetSeed: {
      ...baseV19Manifest("run-v24-parent-repair").resetSeed,
      executionEnvironment: null,
    },
  };
  manifest.parentRunId = undefined;
  manifest.resetSeed.parentRunId = undefined;
  const manifestPath = writeManifest(root, "demo", "run-v24-parent-repair", manifest);

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], { encoding: "utf8" });

  const migrated = readJson(manifestPath);
  assert.equal(migrated.parentRunId, null);
  assert.equal(migrated.resetSeed.parentRunId, null);
});

test("migrate-manifests-v24 rejects invalid repair field shapes", () => {
  const root = tempDir();
  const invalidRuntimeSources = {
    ...baseV19Manifest("run-v24-invalid-vars"),
    schemaVersion: 24,
    runtimeVarSources: [],
    executionEnvironment: null,
    resetSeed: {
      ...baseV19Manifest("run-v24-invalid-vars").resetSeed,
      executionEnvironment: null,
    },
  };
  invalidRuntimeSources.resetSeed.runtimeVarSources = [];
  const invalidMounts = {
    ...baseV19Manifest("run-v24-invalid-mounts"),
    schemaVersion: 24,
    executionEnvironment: {
      ...managedEnvironment(),
      lifecycle: null,
      sessionMounts: "backend",
    },
    resetSeed: {
      ...baseV19Manifest("run-v24-invalid-mounts").resetSeed,
      executionEnvironment: null,
    },
  };
  writeManifest(root, "demo", "run-v24-invalid-vars", invalidRuntimeSources);
  writeManifest(root, "demo", "run-v24-invalid-mounts", invalidMounts);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 24 manifest runtimeVarSources must be an object/);
  assert.match(
    result.stdout,
    /schemaVersion 24 executionEnvironment\.sessionMounts must be an array/,
  );
  assert.match(result.stdout, /SUMMARY migrated=0 conversionErrors=2/);
});

test("migrate-manifests-v24 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV19Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV19Manifest("run-old"), schemaVersion: 18 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 19 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 18/);
  assert.equal(readJson(running).schemaVersion, 19);
  assert.equal("executionEnvironment" in readJson(running), false);
});
