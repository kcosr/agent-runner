#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v12.mjs [--root <path>] [--repo <name>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 11 manifests to 12 by adding schedule: null.",
    "Pass a state root such as ~/.local/state/task-runner with --root.",
    "Use repeated --repo filters to limit migration to selected repo buckets.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/task-runner");
  let write = false;
  const repos = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (!value) throw new Error("--repo requires a bucket name");
      repos.push(value);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { root, write, repos };
}

function atomicWriteJson(path, value) {
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v12-"));
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

function migrateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (manifest.schemaVersion === 12) {
    return manifest;
  }
  if (manifest.schemaVersion !== 11) {
    throw new Error(
      `unsupported schemaVersion ${manifest.schemaVersion}; migrate to schemaVersion 11 first`,
    );
  }
  if ("schedule" in manifest) {
    throw new Error("schemaVersion 11 manifest must not already contain schedule");
  }
  return {
    ...manifest,
    schemaVersion: 12,
    schedule: null,
  };
}

function listRepoBuckets(root, repoFilters) {
  const runsRoot = join(root, "runs");
  if (repoFilters.length > 0) return repoFilters;
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listRunDirs(root, repo) {
  const repoDir = join(root, "runs", repo);
  try {
    return readdirSync(repoDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoDir, entry.name));
  } catch {
    return [];
  }
}

function main() {
  const { root, write, repos } = parseArgs(process.argv.slice(2));
  let failures = 0;
  const buckets = listRepoBuckets(root, repos);

  for (const repo of buckets) {
    for (const runDir of listRunDirs(root, repo)) {
      const manifestPath = join(runDir, "run.json");
      const relativePath = manifestPath
        .slice(root.length + 1)
        .split("\\")
        .join("/");
      try {
        const before = readManifest(manifestPath);
        const after = migrateManifest(before);
        if (isDeepStrictEqual(before, after)) {
          process.stdout.write(`OK    ${relativePath}: already canonical schemaVersion 12\n`);
          continue;
        }
        if (write) {
          atomicWriteJson(manifestPath, after);
          process.stdout.write(`WRITE ${relativePath}: promoted to schemaVersion 12\n`);
        } else {
          process.stdout.write(`DRY   ${relativePath}: would promote to schemaVersion 12\n`);
        }
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
  process.stderr.write(`task-runner: ${err.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}
