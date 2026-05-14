#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v5.mjs [--root <path>] [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/agent-runner");
  let write = false;

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
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { root, write };
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

function normalizeDependencyField(record, label, issues) {
  if (!(label in record) || record[label] === null) {
    record[label] = [];
    return true;
  }
  if (!Array.isArray(record[label])) {
    issues.push(`${label} must be an array or null`);
    return false;
  }
  if (record[label].some((value) => typeof value !== "string")) {
    issues.push(`${label} must contain only strings`);
    return false;
  }
  return false;
}

function migrateManifest(parsed) {
  const issues = [];

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "skip", reason: "JSON root is not an object" };
  }
  if (!("schemaVersion" in parsed)) {
    return { kind: "skip", reason: "missing schemaVersion" };
  }
  if (parsed.schemaVersion !== 4 && parsed.schemaVersion !== 5) {
    return {
      kind: "skip",
      reason: `schemaVersion ${String(parsed.schemaVersion)} is not targeted`,
    };
  }
  if (
    !parsed.resetSeed ||
    typeof parsed.resetSeed !== "object" ||
    Array.isArray(parsed.resetSeed)
  ) {
    return { kind: "error", reason: "missing or invalid resetSeed object" };
  }

  let changed = false;
  if (parsed.schemaVersion === 4) {
    parsed.schemaVersion = 5;
    changed = true;
  }

  const topLevelChanged = normalizeDependencyField(parsed, "dependencyRunIds", issues);
  const seedChanged = normalizeDependencyField(parsed.resetSeed, "dependencyRunIds", issues);
  changed = changed || topLevelChanged || seedChanged;

  if (issues.length > 0) {
    return { kind: "error", reason: issues.join("; ") };
  }

  return { kind: changed ? "change" : "noop", manifest: parsed };
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

  for (const manifestPath of manifests.sort()) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      process.stderr.write(`ERROR ${manifestPath}: invalid JSON (${error.message})\n`);
      errorCount += 1;
      continue;
    }

    const result = migrateManifest(parsed);
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
      process.stdout.write(
        `OK    ${manifestPath}: already schemaVersion 5 with dependency arrays\n`,
      );
      continue;
    }

    changedCount += 1;
    if (options.write) {
      writeJsonAtomic(manifestPath, result.manifest);
      process.stdout.write(
        `WRITE ${manifestPath}: updated to schemaVersion 5 with dependency arrays\n`,
      );
    } else {
      process.stdout.write(
        `DRY   ${manifestPath}: would update to schemaVersion 5 with dependency arrays\n`,
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
