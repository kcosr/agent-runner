#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v10.mjs [--root <path>] [--repo <name>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
    "Migrates schemaVersion 9 manifests to 10 and canonicalizes repairable schemaVersion 10 manifests.",
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

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneArray(value) {
  return Array.isArray(value) ? value.map((entry) => structuredClone(entry)) : [];
}

function cloneRecord(value) {
  if (!isObjectRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, structuredClone(entry)]),
  );
}

function defaultLauncher() {
  return { kind: "direct", name: "direct" };
}

function isValidResolvedLauncherConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value;
  if (record.kind === "direct") {
    return record.name === "direct";
  }
  if (record.kind !== "prefix") {
    return false;
  }
  return (
    typeof record.command === "string" &&
    Array.isArray(record.args) &&
    record.args.every((entry) => typeof entry === "string") &&
    (record.name === null || typeof record.name === "string") &&
    (record.source === "builtin" || record.source === "named" || record.source === "inline")
  );
}

function normalizeCallerInstructions(value) {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error("callerInstructions must be a string or null");
}

function normalizeLauncher(current, fallback, label) {
  if (current === undefined) {
    if (fallback !== undefined) {
      return structuredClone(fallback);
    }
    return defaultLauncher();
  }
  if (!isValidResolvedLauncherConfig(current)) {
    throw new Error(`${label} is not a valid resolved launcher config`);
  }
  return structuredClone(current);
}

function normalizeResetSeed(parsed, launcher) {
  const current = isObjectRecord(parsed.resetSeed) ? parsed.resetSeed : {};
  return {
    ...current,
    backend: typeof current.backend === "string" ? current.backend : parsed.backend,
    model:
      typeof current.model === "string" || current.model === null
        ? current.model
        : (parsed.model ?? null),
    effort:
      typeof current.effort === "string" || current.effort === null
        ? current.effort
        : (parsed.effort ?? null),
    ...(current.backendSpecific !== undefined
      ? { backendSpecific: structuredClone(current.backendSpecific) }
      : parsed.backendSpecific !== undefined
        ? { backendSpecific: structuredClone(parsed.backendSpecific) }
        : {}),
    launcher: normalizeLauncher(current.launcher, launcher, "resetSeed.launcher"),
    cwd: typeof current.cwd === "string" ? current.cwd : parsed.cwd,
    lockedFields: Array.isArray(current.lockedFields)
      ? cloneArray(current.lockedFields)
      : cloneArray(parsed.lockedFields),
    message:
      typeof current.message === "string" || current.message === null
        ? current.message
        : (parsed.message ?? null),
    name:
      typeof current.name === "string" || current.name === null
        ? current.name
        : (parsed.name ?? null),
    note:
      typeof current.note === "string" || current.note === null
        ? current.note
        : (parsed.note ?? null),
    pinned: typeof current.pinned === "boolean" ? current.pinned : parsed.pinned === true,
    dependencyRunIds: Array.isArray(current.dependencyRunIds)
      ? cloneArray(current.dependencyRunIds)
      : cloneArray(parsed.dependencyRunIds),
    unrestricted:
      typeof current.unrestricted === "boolean"
        ? current.unrestricted
        : parsed.unrestricted === true,
    timeoutSec: typeof current.timeoutSec === "number" ? current.timeoutSec : parsed.timeoutSec,
    maxAttempts: typeof current.maxAttempts === "number" ? current.maxAttempts : parsed.maxAttempts,
    brief: typeof current.brief === "string" ? current.brief : parsed.brief,
    runtimeVars: cloneRecord(
      isObjectRecord(current.runtimeVars) ? current.runtimeVars : parsed.runtimeVars,
    ),
    hookState: cloneRecord(current.hookState),
    attachments: Array.isArray(current.attachments)
      ? cloneArray(current.attachments)
      : cloneArray(parsed.attachments),
    finalTasks: cloneRecord(
      isObjectRecord(current.finalTasks) ? current.finalTasks : parsed.finalTasks,
    ),
  };
}

function normalizeManifest(parsed) {
  const resetSeedRecord = isObjectRecord(parsed.resetSeed) ? parsed.resetSeed : {};
  const launcher = normalizeLauncher(parsed.launcher, resetSeedRecord.launcher, "launcher");
  return {
    ...parsed,
    schemaVersion: 10,
    archivedAt: parsed.archivedAt ?? null,
    note: parsed.note ?? null,
    pinned: parsed.pinned ?? false,
    launcher,
    callerInstructions: normalizeCallerInstructions(parsed.callerInstructions),
    resetSeed: normalizeResetSeed(parsed, launcher),
  };
}

function repoFromManifestPath(manifestPath) {
  const repoDir = dirname(dirname(manifestPath));
  return basename(repoDir);
}

function migrateManifest(parsed) {
  if (!isObjectRecord(parsed)) {
    return { kind: "skip", reason: "JSON root is not an object" };
  }
  if (!("schemaVersion" in parsed)) {
    return { kind: "skip", reason: "missing schemaVersion" };
  }

  if (!isObjectRecord(parsed.resetSeed)) {
    return {
      kind: "error",
      reason: `schemaVersion ${String(parsed.schemaVersion)} manifest is missing resetSeed object`,
    };
  }

  let normalized;
  try {
    normalized = normalizeManifest(parsed);
  } catch (error) {
    return { kind: "error", reason: error.message };
  }

  if (parsed.schemaVersion === 10) {
    if (isDeepStrictEqual(parsed, normalized)) {
      return { kind: "noop", manifest: parsed };
    }
    return { kind: "change", action: "canonicalized", manifest: normalized };
  }

  if (parsed.schemaVersion !== 9) {
    return {
      kind: "skip",
      reason: `schemaVersion ${String(parsed.schemaVersion)} is not targeted`,
    };
  }

  return {
    kind: "change",
    action: "promoted",
    manifest: normalized,
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
    process.stderr.write(`task-runner migrate: ${error.message}\n`);
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
    process.stderr.write(`task-runner migrate: failed to scan ${runsRoot}: ${error.message}\n`);
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
      process.stdout.write(`OK    ${manifestPath}: already canonical schemaVersion 10 state\n`);
      continue;
    }

    changedCount += 1;
    if (options.write) {
      writeJsonAtomic(manifestPath, result.manifest);
      if (result.action === "promoted") {
        process.stdout.write(`WRITE ${manifestPath}: promoted to schemaVersion 10\n`);
      } else {
        process.stdout.write(`WRITE ${manifestPath}: canonicalized schemaVersion 10 state\n`);
      }
    } else if (result.action === "promoted") {
      process.stdout.write(`DRY   ${manifestPath}: would promote to schemaVersion 10\n`);
    } else {
      process.stdout.write(`DRY   ${manifestPath}: would canonicalize schemaVersion 10 state\n`);
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
