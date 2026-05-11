#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const TARGET_SCHEMA_VERSION = 24;
const MIN_SUPPORTED_SCHEMA_VERSION = 19;

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v24.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 19-23 manifests to 24 by adding execution environment state",
    "and converting legacy workspace lifecycle state to top-level environment lifecycle state.",
    "Pass a state root such as ~/.local/state/task-runner with --root.",
    "Use repeated --repo filters to limit migration to selected repo buckets.",
    "Use repeated --file paths to migrate only specific run.json manifests.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/task-runner");
  let write = false;
  const repos = [];
  const files = [];
  function readRequiredValue(index, flag, description) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires ${description}`);
    return value;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      write = true;
    } else if (arg === "--root") {
      root = resolve(readRequiredValue(index, "--root", "a path"));
      index += 1;
    } else if (arg === "--repo") {
      repos.push(readRequiredValue(index, "--repo", "a bucket name"));
      index += 1;
    } else if (arg === "--file") {
      files.push(resolve(readRequiredValue(index, "--file", "a path")));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (files.length > 0 && repos.length > 0) {
    throw new Error("--file cannot be combined with --repo");
  }
  return { root, write, repos: [...new Set(repos)], files: [...new Set(files)] };
}

function atomicWriteJson(path, value) {
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v24-"));
  const tmpPath = join(tmpDir, basename(path));
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmpPath, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
}

function listRepoBuckets(root, repoFilters) {
  const runsRoot = join(root, "runs");
  if (repoFilters.length > 0) return repoFilters;
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    throw new Error(`runs root ${runsRoot} does not exist or cannot be read: ${err.message}`);
  }
}

function listRunDirs(root, repo) {
  const repoDir = join(root, "runs", repo);
  try {
    return readdirSync(repoDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoDir, entry.name))
      .filter((runDir) => existsSync(join(runDir, "run.json")));
  } catch {
    return [];
  }
}

function collectManifestPaths(root, repos, files) {
  if (files.length > 0) {
    return files.map((path) => ({ path, label: path }));
  }
  return listRepoBuckets(root, repos).flatMap((repo) =>
    listRunDirs(root, repo).map((runDir) => {
      const path = join(runDir, "run.json");
      return {
        path,
        label: path
          .slice(root.length + 1)
          .split("\\")
          .join("/"),
      };
    }),
  );
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeLifecycleStep(step) {
  if (!isObjectRecord(step)) {
    throw new Error("legacy lifecycle step must be an object");
  }
  if (step.kind === "command") {
    return {
      kind: "command",
      target: step.target ?? "container",
      command: step.command,
      args: Array.isArray(step.args) ? step.args : [],
      env: isObjectRecord(step.env) ? step.env : {},
      cwd: step.cwd ?? null,
      timeoutMs: step.timeoutMs ?? null,
      user: step.user ?? null,
      detach: step.detach ?? false,
    };
  }
  if (step.kind === "git-clone") {
    return {
      kind: "git-clone",
      target: step.target ?? "container",
      source: step.source,
      baseRef: step.baseRef,
      branch: step.branch,
      timeoutMs: step.timeoutMs ?? null,
    };
  }
  throw new Error(`unsupported legacy lifecycle step kind ${String(step.kind)}`);
}

function isValidLifecycleTimeout(value) {
  return value === null || (Number.isInteger(value) && value > 0);
}

function validateLifecycleStep(step, label) {
  if (!isObjectRecord(step)) {
    throw new Error(`schemaVersion 24 ${label} lifecycle step must be an object`);
  }
  if (step.target !== "host" && step.target !== "container") {
    throw new Error(`schemaVersion 24 ${label} lifecycle step has invalid target`);
  }
  if (!isValidLifecycleTimeout(step.timeoutMs)) {
    throw new Error(`schemaVersion 24 ${label} lifecycle step has invalid timeoutMs`);
  }
  if (step.kind === "command") {
    if (step.target === "host" && (step.user !== null || step.detach !== false)) {
      throw new Error(`schemaVersion 24 ${label} host lifecycle command cannot set user or detach`);
    }
    if (
      typeof step.command !== "string" ||
      !Array.isArray(step.args) ||
      !step.args.every((entry) => typeof entry === "string") ||
      !isObjectRecord(step.env) ||
      !Object.values(step.env).every((entry) => typeof entry === "string") ||
      (step.cwd !== null && typeof step.cwd !== "string") ||
      (step.user !== null && typeof step.user !== "string") ||
      typeof step.detach !== "boolean"
    ) {
      throw new Error(`schemaVersion 24 ${label} command lifecycle step is invalid`);
    }
    return;
  }
  if (
    step.kind !== "git-clone" ||
    typeof step.source !== "string" ||
    typeof step.baseRef !== "string" ||
    typeof step.branch !== "string"
  ) {
    throw new Error(`schemaVersion 24 ${label} git-clone lifecycle step is invalid`);
  }
}

function validateLifecyclePhase(phase, label) {
  if (phase === null) return;
  if (!isObjectRecord(phase) || !Array.isArray(phase.steps)) {
    throw new Error(`schemaVersion 24 ${label} lifecycle phase is invalid`);
  }
  for (const step of phase.steps) {
    validateLifecycleStep(step, label);
  }
}

function validateManagedLifecycle(lifecycle, label) {
  if (lifecycle === null) return;
  if (!isObjectRecord(lifecycle)) {
    throw new Error(`schemaVersion 24 ${label}.lifecycle must be an object or null`);
  }
  validateLifecyclePhase(lifecycle.afterStart ?? null, `${label}.lifecycle.afterStart`);
  validateLifecyclePhase(
    lifecycle.onWorkspaceCreate ?? null,
    `${label}.lifecycle.onWorkspaceCreate`,
  );
}

function normalizeWorkspace(workspace, version) {
  if (workspace === undefined || workspace === null) {
    return { workspace: null, onWorkspaceCreate: null };
  }
  if (!isObjectRecord(workspace)) {
    throw new Error("managed executionEnvironment.workspace must be an object or null");
  }
  const { lifecycle, ...nextWorkspace } = workspace;
  let onWorkspaceCreate = null;
  if (version < TARGET_SCHEMA_VERSION && lifecycle !== undefined && lifecycle !== null) {
    if (!isObjectRecord(lifecycle)) {
      throw new Error("legacy workspace.lifecycle must be an object or null");
    }
    const onCreate = lifecycle.onCreate ?? [];
    if (!Array.isArray(onCreate)) {
      throw new Error("legacy workspace.lifecycle.onCreate must be an array");
    }
    onWorkspaceCreate =
      onCreate.length === 0
        ? null
        : {
            steps: onCreate.map(normalizeLifecycleStep),
            completedAt: lifecycle.completedAt ?? null,
            lastError: lifecycle.lastError ?? null,
          };
  }
  return { workspace: nextWorkspace, onWorkspaceCreate };
}

function recordRepair(repairs, description) {
  repairs.push(description);
}

function normalizeExecutionEnvironment(environment, version, repairs, label) {
  if (environment === undefined || environment === null) {
    return null;
  }
  if (!isObjectRecord(environment)) {
    throw new Error("executionEnvironment must be an object or null");
  }
  if (environment.mode !== "managed") {
    return environment;
  }
  const next = { ...environment };
  const { workspace, onWorkspaceCreate } = normalizeWorkspace(next.workspace, version);
  next.workspace = workspace;
  if (next.sessionMounts === undefined) {
    if (version === TARGET_SCHEMA_VERSION) {
      recordRepair(repairs, `${label}.sessionMounts`);
    }
    next.sessionMounts = [];
  } else if (!Array.isArray(next.sessionMounts)) {
    throw new Error(`schemaVersion ${version} ${label}.sessionMounts must be an array`);
  }
  if (version === TARGET_SCHEMA_VERSION && !("lifecycle" in next)) {
    recordRepair(repairs, `${label}.lifecycle`);
  }
  next.lifecycle = normalizeManagedLifecycle(next.lifecycle, onWorkspaceCreate);
  return next;
}

function normalizeManagedLifecycle(existingLifecycle, onWorkspaceCreate) {
  const existing = existingLifecycle === undefined ? null : existingLifecycle;
  if (existing === null && onWorkspaceCreate === null) {
    return null;
  }
  if (existing !== null && !isObjectRecord(existing)) {
    throw new Error("managed executionEnvironment.lifecycle must be an object or null");
  }
  return {
    afterStart: existing?.afterStart ?? null,
    onWorkspaceCreate: existing?.onWorkspaceCreate ?? onWorkspaceCreate,
  };
}

function validateCanonicalV24(manifest) {
  if (manifest.schemaVersion !== TARGET_SCHEMA_VERSION) {
    throw new Error("canonical manifest was not promoted to schemaVersion 24");
  }
  if (!isObjectRecord(manifest.runtimeVarSources)) {
    throw new Error("schemaVersion 24 manifest is missing runtimeVarSources object");
  }
  if (manifest.parentRunId !== null && typeof manifest.parentRunId !== "string") {
    throw new Error("schemaVersion 24 manifest parentRunId must be a string or null");
  }
  if (!("executionEnvironment" in manifest)) {
    throw new Error("schemaVersion 24 manifest is missing executionEnvironment");
  }
  if (!isObjectRecord(manifest.resetSeed)) {
    throw new Error("schemaVersion 24 manifest is missing resetSeed object");
  }
  if (!isObjectRecord(manifest.resetSeed.runtimeVarSources)) {
    throw new Error("schemaVersion 24 manifest resetSeed is missing runtimeVarSources object");
  }
  if (
    manifest.resetSeed.parentRunId !== null &&
    typeof manifest.resetSeed.parentRunId !== "string"
  ) {
    throw new Error("schemaVersion 24 manifest resetSeed parentRunId must be a string or null");
  }
  if (!("executionEnvironment" in manifest.resetSeed)) {
    throw new Error("schemaVersion 24 manifest resetSeed is missing executionEnvironment");
  }
  for (const [label, environment] of [
    ["executionEnvironment", manifest.executionEnvironment],
    ["resetSeed.executionEnvironment", manifest.resetSeed.executionEnvironment],
  ]) {
    if (environment === null) continue;
    if (!isObjectRecord(environment)) {
      throw new Error(`schemaVersion 24 ${label} must be an object or null`);
    }
    if (environment.mode !== "managed") continue;
    if (environment.workspace !== null && "lifecycle" in environment.workspace) {
      throw new Error(`schemaVersion 24 ${label}.workspace still contains lifecycle`);
    }
    if (!("lifecycle" in environment)) {
      throw new Error(`schemaVersion 24 ${label} is missing lifecycle`);
    }
    validateManagedLifecycle(environment.lifecycle, label);
    if (!Array.isArray(environment.sessionMounts)) {
      throw new Error(`schemaVersion 24 ${label}.sessionMounts must be an array`);
    }
  }
}

function migrateManifest(manifest) {
  if (!isObjectRecord(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (
    typeof manifest.schemaVersion !== "number" ||
    manifest.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION ||
    manifest.schemaVersion > TARGET_SCHEMA_VERSION
  ) {
    throw new Error(
      `unsupported schemaVersion ${manifest.schemaVersion}; migrate to schemaVersion ${MIN_SUPPORTED_SCHEMA_VERSION} first`,
    );
  }
  if (manifest.status === "running") {
    throw new Error(
      `schemaVersion ${manifest.schemaVersion} manifest is running; stop the run before migrating this workspace`,
    );
  }

  const originalVersion = manifest.schemaVersion;
  const repairs = [];
  const next = cloneJson(manifest);
  if (!isObjectRecord(next.resetSeed)) {
    throw new Error(`schemaVersion ${originalVersion} manifest is missing resetSeed object`);
  }
  next.schemaVersion = TARGET_SCHEMA_VERSION;
  if (!isObjectRecord(next.runtimeVarSources)) {
    if (next.runtimeVarSources !== undefined) {
      throw new Error(
        `schemaVersion ${originalVersion} manifest runtimeVarSources must be an object`,
      );
    }
    if (originalVersion === TARGET_SCHEMA_VERSION) {
      recordRepair(repairs, "runtimeVarSources");
    }
    next.runtimeVarSources = {};
  }
  if (!isObjectRecord(next.resetSeed.runtimeVarSources)) {
    if (next.resetSeed.runtimeVarSources !== undefined) {
      throw new Error(
        `schemaVersion ${originalVersion} manifest resetSeed.runtimeVarSources must be an object`,
      );
    }
    if (originalVersion === TARGET_SCHEMA_VERSION) {
      recordRepair(repairs, "resetSeed.runtimeVarSources");
    }
    next.resetSeed.runtimeVarSources = {};
  }
  if (next.parentRunId === undefined) {
    if (originalVersion === TARGET_SCHEMA_VERSION) {
      recordRepair(repairs, "parentRunId");
    }
    next.parentRunId = null;
  }
  if (next.resetSeed.parentRunId === undefined) {
    if (originalVersion === TARGET_SCHEMA_VERSION) {
      recordRepair(repairs, "resetSeed.parentRunId");
    }
    next.resetSeed.parentRunId = null;
  }
  next.executionEnvironment = normalizeExecutionEnvironment(
    next.executionEnvironment,
    originalVersion,
    repairs,
    "executionEnvironment",
  );
  next.resetSeed.executionEnvironment = normalizeExecutionEnvironment(
    next.resetSeed.executionEnvironment,
    originalVersion,
    repairs,
    "resetSeed.executionEnvironment",
  );

  validateCanonicalV24(next);
  return {
    manifest: next,
    changed: JSON.stringify(next) !== JSON.stringify(manifest),
    repaired: originalVersion === TARGET_SCHEMA_VERSION && repairs.length > 0,
    repairs,
  };
}

function migrateManifestFile(record, write, stats) {
  const before = readManifest(record.path);
  const { manifest: after, changed, repaired, repairs } = migrateManifest(before);
  if (!changed) {
    process.stdout.write(`OK    ${record.label}: already canonical schemaVersion 24\n`);
    return;
  }
  stats.migrated += 1;
  const repairSuffix = repairs.length > 0 ? ` (${repairs.join(", ")})` : "";
  if (write) {
    atomicWriteJson(record.path, after);
    process.stdout.write(
      repaired
        ? `WRITE ${record.label}: repaired canonical schemaVersion 24${repairSuffix}\n`
        : `WRITE ${record.label}: promoted to schemaVersion 24\n`,
    );
  } else {
    process.stdout.write(
      repaired
        ? `DRY   ${record.label}: would repair canonical schemaVersion 24${repairSuffix}\n`
        : `DRY   ${record.label}: would promote to schemaVersion 24\n`,
    );
  }
}

function main() {
  const { root, write, repos, files } = parseArgs(process.argv.slice(2));
  const records = collectManifestPaths(root, repos, files);
  let failures = 0;
  const stats = { migrated: 0 };
  for (const record of records) {
    try {
      migrateManifestFile(record, write, stats);
    } catch (err) {
      failures += 1;
      process.stdout.write(`ERROR ${record.label}: ${err.message}\n`);
    }
  }
  process.stdout.write(`SUMMARY migrated=${stats.migrated} conversionErrors=${failures}\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`migrate-manifests-v24: ${err.message}\n`);
  process.exit(1);
}
