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

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v15.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 14 manifests to 15 by adding runGroupId and typed dependencies.",
    "Pass a state root such as ~/.local/state/agent-runner with --root.",
    "Use repeated --repo filters to limit migration to selected repo buckets.",
    "Use repeated --file paths to migrate only specific run.json manifests.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/agent-runner");
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
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v15-"));
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

function dependencyRefs(dependencyRunIds, label) {
  if (!Array.isArray(dependencyRunIds)) {
    throw new Error(`${label} must be an array`);
  }
  return dependencyRunIds.map((runId) => {
    if (typeof runId !== "string") {
      throw new Error(`${label} must contain only strings`);
    }
    return { type: "run", runId };
  });
}

function resolveLineageRoot(runId, manifestsByRunId) {
  let current = manifestsByRunId.get(runId);
  const seen = new Set();
  while (current?.parentRunId) {
    if (seen.has(current.runId)) return null;
    seen.add(current.runId);
    const parent = manifestsByRunId.get(current.parentRunId);
    if (!parent) return null;
    current = parent;
  }
  return current?.runId ?? null;
}

function migrateManifest(manifest, manifestsByRunId) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (manifest.schemaVersion === 15) {
    if (
      typeof manifest.runGroupId !== "string" ||
      !Array.isArray(manifest.dependencies) ||
      "dependencyRunIds" in manifest ||
      "dependencyRunIds" in (manifest.resetSeed ?? {})
    ) {
      throw new Error("schemaVersion 15 manifest is not canonical");
    }
    return { manifest, changed: false, warning: null };
  }
  if (manifest.schemaVersion !== 14) {
    throw new Error(
      `unsupported schemaVersion ${manifest.schemaVersion}; migrate to schemaVersion 14 first`,
    );
  }
  if (manifest.status === "running") {
    throw new Error(
      "schemaVersion 14 manifest is running; stop the run before migrating this workspace",
    );
  }
  if (!manifest.resetSeed || typeof manifest.resetSeed !== "object") {
    throw new Error("schemaVersion 14 manifest is missing resetSeed object");
  }
  const lineageRoot = resolveLineageRoot(manifest.runId, manifestsByRunId);
  const runGroupId = lineageRoot ?? manifest.runId;
  const warning =
    lineageRoot === null
      ? `unresolved lineage for ${manifest.runId}; using singleton group ${manifest.runId}`
      : null;
  const {
    dependencyRunIds: topLevelDependencyRunIds,
    resetSeed: resetSeedBefore,
    ...rest
  } = manifest;
  const { dependencyRunIds: seedDependencyRunIds, ...resetSeed } = resetSeedBefore;
  return {
    manifest: {
      ...rest,
      schemaVersion: 15,
      runGroupId,
      dependencies: dependencyRefs(topLevelDependencyRunIds, "dependencyRunIds"),
      resetSeed: {
        ...resetSeed,
        runGroupId,
        dependencies: dependencyRefs(seedDependencyRunIds, "resetSeed.dependencyRunIds"),
      },
    },
    changed: true,
    warning,
  };
}

function migrateManifestFile(record, write, manifestsByRunId, stats) {
  const before = readManifest(record.path);
  const { manifest: after, changed, warning } = migrateManifest(before, manifestsByRunId);
  if (warning) {
    stats.warnings += 1;
    process.stdout.write(`WARN  ${record.label}: ${warning}\n`);
  }
  if (!changed) {
    process.stdout.write(`OK    ${record.label}: already canonical schemaVersion 15\n`);
    return;
  }
  stats.migrated += 1;
  stats.groups.add(after.runGroupId);
  if (write) {
    atomicWriteJson(record.path, after);
    process.stdout.write(`WRITE ${record.label}: promoted to schemaVersion 15\n`);
  } else {
    process.stdout.write(`DRY   ${record.label}: would promote to schemaVersion 15\n`);
  }
}

function main() {
  const { root, write, repos, files } = parseArgs(process.argv.slice(2));
  const records = collectManifestPaths(root, repos, files);
  const manifestsByRunId = new Map();
  for (const record of records) {
    try {
      const manifest = readManifest(record.path);
      if (typeof manifest.runId === "string") manifestsByRunId.set(manifest.runId, manifest);
    } catch {
      // Per-file migration below reports parse errors with the normal label.
    }
  }
  let failures = 0;
  const stats = { migrated: 0, warnings: 0, groups: new Set() };
  for (const record of records) {
    try {
      migrateManifestFile(record, write, manifestsByRunId, stats);
    } catch (err) {
      failures += 1;
      process.stdout.write(`ERROR ${record.label}: ${err.message}\n`);
    }
  }
  process.stdout.write(
    `SUMMARY migrated=${stats.migrated} groups=${stats.groups.size} warnings=${stats.warnings} conversionErrors=${failures}\n`,
  );
  if (failures > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
