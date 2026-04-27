import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v15.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v15-"));
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

function baseV14Manifest(runId = "run-a", parentRunId = null) {
  return {
    schemaVersion: 14,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "claude",
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
    endedAt: null,
    archivedAt: null,
    status: "ready",
    dependencyRunIds: ["dep-a"],
    parentRunId,
    schedule: null,
    exitCode: null,
    totalAttemptCount: 0,
    maxAttemptsPerSession: 3,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: null,
    runtimeVars: {},
    runtimeVarSources: {},
    execution: { hostMode: "embedded", controller: { kind: "embedded" } },
    brief: "brief",
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    callerInstructions: null,
    resetSeed: {
      backend: "claude",
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
      dependencyRunIds: ["dep-a"],
      parentRunId,
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
    totalSessionCount: 0,
    sessions: [],
    attemptRecords: [],
  };
}

test("migrate-manifests-v15 dry-runs v14 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV14Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 15/);
  assert.match(stdout, /SUMMARY migrated=1 groups=1 warnings=0 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 14);
});

test("migrate-manifests-v15 writes group roots and typed dependencies", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-root", baseV14Manifest("run-root"));
  const childPath = writeManifest(
    root,
    "demo",
    "run-child",
    baseV14Manifest("run-child", "run-root"),
  );

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-child\/run\.json: promoted to schemaVersion 15/);
  const child = readJson(childPath);
  assert.equal(child.schemaVersion, 15);
  assert.equal(child.runGroupId, "run-root");
  assert.deepEqual(child.dependencies, [{ type: "run", runId: "dep-a" }]);
  assert.equal("dependencyRunIds" in child, false);
  assert.equal(child.resetSeed.runGroupId, "run-root");
  assert.deepEqual(child.resetSeed.dependencies, [{ type: "run", runId: "dep-a" }]);
  assert.equal("dependencyRunIds" in child.resetSeed, false);
});

test("migrate-manifests-v15 warns and uses singleton group for unresolved lineage", () => {
  const root = tempDir();
  const manifestPath = writeManifest(
    root,
    "demo",
    "run-orphan",
    baseV14Manifest("run-orphan", "missing-parent"),
  );

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WARN\s+runs\/demo\/run-orphan\/run\.json: unresolved lineage/);
  assert.equal(readJson(manifestPath).runGroupId, "run-orphan");
});

test("migrate-manifests-v15 supports repo and file filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", baseV14Manifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", baseV14Manifest("run-b"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--write"], {
    encoding: "utf8",
  });
  assert.equal(readJson(repoA).schemaVersion, 15);
  assert.equal(readJson(repoB).schemaVersion, 14);

  execFileSync("node", [SCRIPT_PATH, "--file", repoB, "--write"], { encoding: "utf8" });
  assert.equal(readJson(repoB).schemaVersion, 15);
});

test("migrate-manifests-v15 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV14Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV14Manifest("run-old"), schemaVersion: 13 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 14 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 13/);
  assert.equal(readJson(running).schemaVersion, 14);
});
