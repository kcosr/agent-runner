#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v8.mjs [--root <path>] [--repo <name>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Pass a legacy state root such as ~/.local/state/agent-runner with --root.",
    "Use repeated --repo filters to limit migration to selected repo buckets.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/agent-runner");
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
      if (!value) {
        throw new Error("--root requires a path");
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--repo requires a bucket name");
      }
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

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function repoFromManifestPath(manifestPath) {
  const repoDir = dirname(dirname(manifestPath));
  return basename(repoDir);
}

function migrateManifest(parsed, manifestPath) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "skip", reason: "JSON root is not an object" };
  }
  if (!("schemaVersion" in parsed)) {
    return { kind: "skip", reason: "missing schemaVersion" };
  }

  if (parsed.schemaVersion === 8) {
    if (!nonEmptyString(parsed.repo)) {
      return { kind: "error", reason: "schemaVersion 8 manifest is missing repo string" };
    }
    return { kind: "noop", manifest: parsed };
  }

  if (parsed.schemaVersion !== 7) {
    return {
      kind: "skip",
      reason: `schemaVersion ${String(parsed.schemaVersion)} is not targeted`,
    };
  }

  const repo = repoFromManifestPath(manifestPath);
  if (!nonEmptyString(repo)) {
    return { kind: "error", reason: "unable to derive repo bucket from manifest path" };
  }

  return {
    kind: "change",
    manifest: {
      ...parsed,
      schemaVersion: 8,
      repo,
      archivedAt: parsed.archivedAt ?? null,
    },
  };
}

function writeJsonAtomic(path, value) {
  const tempDir = mkdtempSync(join(dirname(path), ".manifest-migrate-"));
  const tempPath = join(tempDir, "run.json.tmp");
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tempPath, path);
  rmSync(tempDir, { recursive: true, force: true });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`agent-runner migrate: ${error.message}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exit(2);
  }

  const manifests = [];
  const runsRoot = join(options.root, "runs");

  try {
    for (const path of walk(runsRoot)) {
      if (basename(path) === "run.json") {
        manifests.push(path);
      }
    }
  } catch (error) {
    process.stderr.write(`agent-runner migrate: failed to scan ${runsRoot}: ${error.message}\n`);
    process.exit(1);
  }

  let changedCount = 0;
  let noopCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const selectedRepos = options.repos.length > 0 ? new Set(options.repos) : null;

  for (const manifestPath of manifests.sort()) {
    const repo = repoFromManifestPath(manifestPath);
    if (selectedRepos && !selectedRepos.has(repo)) {
      skippedCount += 1;
      process.stdout.write(`SKIP  ${manifestPath}: repo bucket ${repo} not selected\n`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      process.stderr.write(`ERROR ${manifestPath}: invalid JSON (${error.message})\n`);
      errorCount += 1;
      continue;
    }

    const result = migrateManifest(parsed, manifestPath);
    if (result.kind === "skip") {
      skippedCount += 1;
      process.stdout.write(`SKIP  ${manifestPath}: ${result.reason}\n`);
      continue;
    }
    if (result.kind === "error") {
      errorCount += 1;
      process.stderr.write(`ERROR ${manifestPath}: ${result.reason}\n`);
      continue;
    }
    if (result.kind === "noop") {
      noopCount += 1;
      process.stdout.write(`OK    ${manifestPath}: already schemaVersion 8 with repo capture\n`);
      continue;
    }

    changedCount += 1;
    if (options.write) {
      writeJsonAtomic(manifestPath, result.manifest);
      process.stdout.write(`WRITE ${manifestPath}: updated to schemaVersion 8 with repo capture\n`);
    } else {
      process.stdout.write(
        `DRY   ${manifestPath}: would update to schemaVersion 8 with repo capture\n`,
      );
    }
  }

  process.stdout.write(
    [
      "",
      `Scanned: ${manifests.length}`,
      `Changed: ${changedCount}${options.write ? " written" : " (dry-run)"}`,
      `No-op: ${noopCount}`,
      `Skipped: ${skippedCount}`,
      `Errors: ${errorCount}`,
      "",
    ].join("\n"),
  );

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
