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
    "Usage: node scripts/migrate-manifests-v19.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 18 manifests to 19 by adding backend session sync state and task-runner history provenance.",
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
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v19-"));
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

function isQueuedResumeMessages(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        isObjectRecord(message) &&
        typeof message.id === "string" &&
        typeof message.text === "string" &&
        typeof message.createdAt === "string",
    )
  );
}

function isTaskRunnerProvenance(value) {
  return isObjectRecord(value) && value.kind === "task_runner" && Object.keys(value).length === 1;
}

function validateCanonicalV19(manifest) {
  if (!isQueuedResumeMessages(manifest.queuedResumeMessages)) {
    throw new Error("schemaVersion 19 manifest is missing queuedResumeMessages array");
  }
  if (manifest.backendSessionSync !== null) {
    throw new Error("schemaVersion 19 manifest backendSessionSync must be null after migration");
  }
  const invalidAttempt = (manifest.attemptRecords ?? []).find(
    (record) => !isTaskRunnerProvenance(record.provenance),
  );
  if (invalidAttempt) {
    throw new Error(
      `schemaVersion 19 manifest attempt ${invalidAttempt.attemptNumber} is missing task_runner provenance`,
    );
  }
  const invalidSession = (manifest.sessions ?? []).find(
    (record) => !isTaskRunnerProvenance(record.provenance),
  );
  if (invalidSession) {
    throw new Error(
      `schemaVersion 19 manifest session ${invalidSession.sessionIndex} is missing task_runner provenance`,
    );
  }
}

function migrateManifest(manifest) {
  if (!isObjectRecord(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (manifest.schemaVersion === 19) {
    validateCanonicalV19(manifest);
    return { manifest, changed: false };
  }
  if (manifest.schemaVersion !== 18) {
    throw new Error(
      `unsupported schemaVersion ${manifest.schemaVersion}; migrate to schemaVersion 18 first`,
    );
  }
  if (manifest.status === "running") {
    throw new Error(
      "schemaVersion 18 manifest is running; stop the run before migrating this workspace",
    );
  }
  if ("backendSessionSync" in manifest) {
    throw new Error("schemaVersion 18 manifest already contains backendSessionSync");
  }

  return {
    manifest: {
      ...manifest,
      schemaVersion: 19,
      backendSessionSync: null,
      sessions: (manifest.sessions ?? []).map((session) => ({
        ...session,
        provenance: { kind: "task_runner" },
      })),
      attemptRecords: (manifest.attemptRecords ?? []).map((attempt) => ({
        ...attempt,
        provenance: { kind: "task_runner" },
      })),
    },
    changed: true,
  };
}

function migrateManifestFile(record, write, stats) {
  const before = readManifest(record.path);
  const { manifest: after, changed } = migrateManifest(before);
  if (!changed) {
    process.stdout.write(`OK    ${record.label}: already canonical schemaVersion 19\n`);
    return;
  }
  stats.migrated += 1;
  if (write) {
    atomicWriteJson(record.path, after);
    process.stdout.write(`WRITE ${record.label}: promoted to schemaVersion 19\n`);
  } else {
    process.stdout.write(`DRY   ${record.label}: would promote to schemaVersion 19\n`);
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
  process.stderr.write(`${err.message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
