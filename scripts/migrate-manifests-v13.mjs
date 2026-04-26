#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v13.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Removes redundant attemptRecords[].tasksAfter fields from run.json manifests.",
    "Pass a state root such as ~/.local/state/task-runner with --root.",
    "Use repeated --repo filters to limit cleanup to selected repo buckets.",
    "Use repeated --file paths to clean only specific run.json manifests.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/task-runner");
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

function detectIndent(raw) {
  const match = raw.match(/^(?<indent>[ \t]+)"[^"]+":/m);
  return match?.groups?.indent ?? 2;
}

function formatManifest(raw, manifest) {
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(manifest, null, detectIndent(raw))}${trailingNewline}`;
}

function atomicWriteText(path, text) {
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v13-"));
  const tmpPath = join(tmpDir, basename(path));
  try {
    writeFileSync(tmpPath, text);
    renameSync(tmpPath, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readManifest(path) {
  const raw = readFileSync(path, "utf8");
  try {
    return { raw, manifest: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
}

function cleanManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (!Array.isArray(manifest.attemptRecords)) {
    return 0;
  }

  let cleanedAttempts = 0;
  manifest.attemptRecords = manifest.attemptRecords.map((record) => {
    if (
      record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      Object.hasOwn(record, "tasksAfter")
    ) {
      const { tasksAfter: _oldTasksAfter, ...cleanedRecord } = record;
      cleanedAttempts += 1;
      return cleanedRecord;
    }
    return record;
  });
  return cleanedAttempts;
}

function cleanManifestFile(manifestPath, label, write) {
  const { raw, manifest } = readManifest(manifestPath);
  const cleanedAttempts = cleanManifest(manifest);
  if (cleanedAttempts === 0) {
    process.stdout.write(`OK    ${label}: no tasksAfter fields found\n`);
    return { manifestsCleaned: 0, attemptsCleaned: 0, bytesSaved: 0 };
  }

  const after = formatManifest(raw, manifest);
  const bytesSaved = Buffer.byteLength(raw, "utf8") - Buffer.byteLength(after, "utf8");
  if (write) {
    atomicWriteText(manifestPath, after);
    process.stdout.write(
      `WRITE ${label}: removed tasksAfter from ${cleanedAttempts} attempt record(s), saved ${bytesSaved} bytes\n`,
    );
  } else {
    process.stdout.write(
      `DRY   ${label}: would remove tasksAfter from ${cleanedAttempts} attempt record(s), saving ${bytesSaved} bytes\n`,
    );
  }
  return { manifestsCleaned: 1, attemptsCleaned: cleanedAttempts, bytesSaved };
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

function addTotals(totals, result) {
  totals.manifestsCleaned += result.manifestsCleaned;
  totals.attemptsCleaned += result.attemptsCleaned;
  totals.bytesSaved += result.bytesSaved;
}

function printSummary(totals) {
  process.stdout.write(
    `Summary: manifests cleaned=${totals.manifestsCleaned} attempt records cleaned=${totals.attemptsCleaned} bytes saved=${totals.bytesSaved} errors=${totals.errors}\n`,
  );
}

function main() {
  const { root, write, repos, files } = parseArgs(process.argv.slice(2));
  const totals = { manifestsCleaned: 0, attemptsCleaned: 0, bytesSaved: 0, errors: 0 };

  if (files.length > 0) {
    for (const file of files) {
      try {
        addTotals(totals, cleanManifestFile(file, file, write));
      } catch (err) {
        totals.errors += 1;
        process.stdout.write(`ERROR ${file}: ${err.message}\n`);
      }
    }
    printSummary(totals);
    if (totals.errors > 0) {
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
        addTotals(totals, cleanManifestFile(manifestPath, relativePath, write));
      } catch (err) {
        totals.errors += 1;
        process.stdout.write(`ERROR ${relativePath}: ${err.message}\n`);
      }
    }
  }

  printSummary(totals);
  if (totals.errors > 0) {
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
