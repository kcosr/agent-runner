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
    "Usage: node scripts/migrate-attempt-stdout-field.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update attempt logs in place.",
    "Migrates schemaVersion 2 attempts/NN.json files to schemaVersion 3 by removing stdout.",
    "Pass a state root such as ~/.local/state/task-runner with --root.",
    "Use repeated --repo filters to limit migration to selected repo buckets.",
    "Use repeated --file paths to migrate only specific attempt JSON files.",
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
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-attempt-stdout-"));
  const tmpPath = join(tmpDir, basename(path));
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmpPath, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readJson(path) {
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
      .map((entry) => join(repoDir, entry.name));
  } catch {
    return [];
  }
}

function listAttemptLogs(runDir) {
  const attemptsDir = join(runDir, "attempts");
  try {
    return readdirSync(attemptsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map((entry) => join(attemptsDir, entry.name));
  } catch {
    return [];
  }
}

function collectAttemptLogPaths(root, repos, files) {
  if (files.length > 0) {
    return files.map((path) => ({ path, label: path }));
  }
  return listRepoBuckets(root, repos).flatMap((repo) =>
    listRunDirs(root, repo).flatMap((runDir) =>
      listAttemptLogs(runDir).map((path) => ({
        path,
        label: path
          .slice(root.length + 1)
          .split("\\")
          .join("/"),
      })),
    ),
  );
}

function isObjectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function migrateAttemptLogFile(record, write, stats) {
  if (!existsSync(record.path)) {
    throw new Error("file does not exist");
  }
  const before = readJson(record.path);
  if (!isObjectRecord(before)) {
    throw new Error("attempt log must be a JSON object");
  }
  if (before.schemaVersion !== 2 && before.schemaVersion !== 3) {
    throw new Error("attempt log must have schemaVersion 2 or 3");
  }
  if (before.schemaVersion === 3 && !hasOwn(before, "stdout")) {
    process.stdout.write(`OK    ${record.label}: already has no stdout field\n`);
    return;
  }
  const { stdout: _stdout, ...after } = before;
  after.schemaVersion = 3;
  stats.migrated += 1;
  if (write) {
    atomicWriteJson(record.path, after);
    process.stdout.write(`WRITE ${record.label}: migrated to schemaVersion 3\n`);
  } else {
    process.stdout.write(`DRY   ${record.label}: would migrate to schemaVersion 3\n`);
  }
}

function main() {
  const { root, write, repos, files } = parseArgs(process.argv.slice(2));
  const records = collectAttemptLogPaths(root, repos, files);
  let failures = 0;
  const stats = { migrated: 0 };
  for (const record of records) {
    try {
      migrateAttemptLogFile(record, write, stats);
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
  process.stderr.write(`${err.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
