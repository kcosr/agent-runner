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
    "Usage: node scripts/migrate-manifests-v14.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 13 manifests to 14 by removing assignment seed path fields.",
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
      continue;
    }
    if (arg === "--root") {
      const value = readRequiredValue(index, "--root", "a path");
      root = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      const value = readRequiredValue(index, "--repo", "a bucket name");
      repos.push(value);
      index += 1;
      continue;
    }
    if (arg === "--file") {
      const value = readRequiredValue(index, "--file", "a path");
      files.push(resolve(value));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (files.length > 0 && repos.length > 0) {
    throw new Error("--file cannot be combined with --repo");
  }

  return { root, write, repos: [...new Set(repos)], files: [...new Set(files)] };
}

function atomicWriteJson(path, value) {
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v14-"));
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

function removeAssignmentSeedPaths(manifest) {
  const { assignmentPath: _assignmentPath, ...next } = manifest;
  if (next.assignment !== null) {
    const { workspacePath: _workspacePath, ...assignment } = next.assignment;
    next.assignment = assignment;
  }
  return next;
}

function migrateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (manifest.schemaVersion === 14) {
    if (
      "assignmentPath" in manifest ||
      (manifest.assignment !== null &&
        manifest.assignment &&
        typeof manifest.assignment === "object" &&
        "workspacePath" in manifest.assignment)
    ) {
      throw new Error(
        "schemaVersion 14 manifest still contains legacy assignment seed path fields",
      );
    }
    return { manifest, changed: false };
  }
  if (manifest.schemaVersion !== 13) {
    throw new Error(
      `unsupported schemaVersion ${manifest.schemaVersion}; migrate to schemaVersion 13 first`,
    );
  }
  if (manifest.status === "running") {
    throw new Error(
      "schemaVersion 13 manifest is running; stop the run before migrating this workspace",
    );
  }
  if (manifest.assignment !== null) {
    if (!manifest.assignment || typeof manifest.assignment !== "object") {
      throw new Error("schemaVersion 13 manifest assignment must be an object or null");
    }
    if (Array.isArray(manifest.assignment)) {
      throw new Error("schemaVersion 13 manifest assignment must be an object or null");
    }
  }
  return {
    manifest: {
      ...removeAssignmentSeedPaths(manifest),
      schemaVersion: 14,
    },
    changed: true,
  };
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

function migrateManifestFile(manifestPath, label, write) {
  const before = readManifest(manifestPath);
  const { manifest: after, changed } = migrateManifest(before);
  if (!changed) {
    process.stdout.write(`OK    ${label}: already canonical schemaVersion 14\n`);
    return;
  }
  if (write) {
    atomicWriteJson(manifestPath, after);
    process.stdout.write(`WRITE ${label}: promoted to schemaVersion 14\n`);
    return;
  }
  process.stdout.write(`DRY   ${label}: would promote to schemaVersion 14\n`);
}

function main() {
  const { root, write, repos, files } = parseArgs(process.argv.slice(2));
  let failures = 0;
  if (files.length > 0) {
    for (const file of files) {
      try {
        migrateManifestFile(file, file, write);
      } catch (err) {
        failures += 1;
        process.stdout.write(`ERROR ${file}: ${err.message}\n`);
      }
    }
    if (failures > 0) {
      process.exitCode = 1;
    }
    return;
  }

  for (const repo of listRepoBuckets(root, repos)) {
    for (const runDir of listRunDirs(root, repo)) {
      const manifestPath = join(runDir, "run.json");
      const relativePath = manifestPath
        .slice(root.length + 1)
        .split("\\")
        .join("/");
      try {
        migrateManifestFile(manifestPath, relativePath, write);
      } catch (err) {
        failures += 1;
        process.stdout.write(`ERROR ${relativePath}: ${err.message}\n`);
      }
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`agent-runner: ${err.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}
