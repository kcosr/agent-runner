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
    "Usage: node scripts/migrate-agent-seeds.mjs [--root <path>] [--repo <name>]... [--file <path>]... [--write]",
    "",
    "Dry-run by default. Use --write to create missing agent-seed.md files.",
    "Backfills initialized run workspaces created before frozen agent seeds were persisted.",
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function relativeLabel(root, path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function atomicWriteFile(path, contents) {
  const tmpDir = mkdtempSync(join(dirname(path), ".agent-seed-migrate-"));
  const tmpPath = join(tmpDir, basename(path));
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function migrateManifestFile(manifestPath, label, write) {
  const manifest = readJson(manifestPath);
  if (!isRecord(manifest)) {
    throw new Error("manifest must be an object");
  }

  if (manifest.status !== "initialized") {
    return { kind: "skip", message: `${label}: status is ${String(manifest.status)}` };
  }
  if (!isRecord(manifest.agent)) {
    throw new Error("agent must be an object");
  }
  if (manifest.agent.sourcePath === null) {
    return { kind: "ok", message: `${label}: inline agent does not need agent-seed.md` };
  }
  if (typeof manifest.agent.sourcePath !== "string" || manifest.agent.sourcePath.length === 0) {
    throw new Error("agent.sourcePath must be a non-empty string or null");
  }

  const seedPath = join(dirname(manifestPath), "agent-seed.md");
  if (existsSync(seedPath)) {
    return { kind: "ok", message: `${label}: agent-seed.md already exists` };
  }
  if (!existsSync(manifest.agent.sourcePath)) {
    throw new Error(`agent source was not found: ${manifest.agent.sourcePath}`);
  }

  if (write) {
    atomicWriteFile(seedPath, readFileSync(manifest.agent.sourcePath));
    return {
      kind: "write",
      message: `${label}: wrote agent-seed.md from ${manifest.agent.sourcePath}`,
    };
  }
  return {
    kind: "dry",
    message: `${label}: would write agent-seed.md from ${manifest.agent.sourcePath}`,
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

function printResult(result) {
  const prefix =
    result.kind === "write"
      ? "WRITE"
      : result.kind === "dry"
        ? "DRY  "
        : result.kind === "skip"
          ? "SKIP "
          : "OK   ";
  process.stdout.write(`${prefix} ${result.message}\n`);
}

function main() {
  const { root, write, repos, files } = parseArgs(process.argv.slice(2));
  const summary = { ok: 0, dry: 0, write: 0, skip: 0, error: 0 };

  const manifestPaths =
    files.length > 0
      ? files.map((file) => ({ path: file, label: file }))
      : listRepoBuckets(root, repos).flatMap((repo) =>
          listRunDirs(root, repo).map((runDir) => {
            const path = join(runDir, "run.json");
            return { path, label: relativeLabel(root, path) };
          }),
        );

  for (const entry of manifestPaths) {
    if (!existsSync(entry.path)) {
      continue;
    }
    try {
      const result = migrateManifestFile(entry.path, entry.label, write);
      summary[result.kind] += 1;
      printResult(result);
    } catch (err) {
      summary.error += 1;
      process.stdout.write(`ERROR ${entry.label}: ${err.message}\n`);
    }
  }

  process.stdout.write(
    `summary: ok=${summary.ok} dry=${summary.dry} write=${summary.write} skip=${summary.skip} error=${summary.error}\n`,
  );
  if (summary.error > 0) {
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
