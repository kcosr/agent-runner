#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v12.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 11 manifests to 12 by adding schedule: null.",
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
    if (arg === "--file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--file requires a path");
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

  return { root, write, repos, files };
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

function migrateManifestFile(manifestPath, label, write) {
  const before = readManifest(manifestPath);
  const after = migrateManifest(before);
  if (isDeepStrictEqual(before, after)) {
    process.stdout.write(`OK    ${label}: already canonical schemaVersion 12\n`);
    return;
  }
  if (write) {
    atomicWriteJson(manifestPath, after);
    process.stdout.write(`WRITE ${label}: promoted to schemaVersion 12\n`);
    return;
  }
  process.stdout.write(`DRY   ${label}: would promote to schemaVersion 12\n`);
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

  const buckets = listRepoBuckets(root, repos);

  for (const repo of buckets) {
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
