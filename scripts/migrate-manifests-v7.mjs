#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v7.mjs [--root <path>] [--write]",
    "",
    "Dry-run by default. Use --write to update manifests in place.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = join(homedir(), ".local/state/task-runner");
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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function findAttemptPrompt(parsed, attemptNumber) {
  if (!Array.isArray(parsed.attemptRecords)) return null;
  const attempt = parsed.attemptRecords.find((entry) => entry?.attempt === attemptNumber);
  return nonEmptyString(attempt?.prompt);
}

function deriveSessionBrief(parsed, session, manifestBrief) {
  const attemptPrompt = findAttemptPrompt(parsed, session?.firstAttempt);
  if (attemptPrompt) return attemptPrompt;
  if (manifestBrief) return manifestBrief;
  throw new Error(`session ${String(session?.sessionIndex)} is missing a derivable brief`);
}

function deriveManifestBrief(parsed) {
  const direct = nonEmptyString(parsed.pendingPrompt);
  if (direct) return direct;

  if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
    const latestSession = parsed.sessions[parsed.sessions.length - 1];
    const latestSessionBrief = findAttemptPrompt(parsed, latestSession?.firstAttempt);
    if (latestSessionBrief) return latestSessionBrief;
  }

  const latestAttemptPrompt =
    Array.isArray(parsed.attemptRecords) && parsed.attemptRecords.length > 0
      ? nonEmptyString(parsed.attemptRecords[parsed.attemptRecords.length - 1]?.prompt)
      : null;
  if (latestAttemptPrompt) return latestAttemptPrompt;

  const resetSeedPrompt = nonEmptyString(parsed.resetSeed?.pendingPrompt);
  if (resetSeedPrompt) return resetSeedPrompt;

  throw new Error("manifest is missing a derivable brief");
}

function deriveResetSeedBrief(parsed, manifestBrief) {
  const resetSeedPrompt = nonEmptyString(parsed.resetSeed?.pendingPrompt);
  if (resetSeedPrompt) return resetSeedPrompt;

  if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
    const firstSession = parsed.sessions[0];
    const firstSessionBrief = findAttemptPrompt(parsed, firstSession?.firstAttempt);
    if (firstSessionBrief) return firstSessionBrief;
  }

  if (manifestBrief) return manifestBrief;

  throw new Error("resetSeed is missing a derivable brief");
}

function hasLegacyPromptFields(parsed) {
  return (
    "pendingPrompt" in parsed ||
    "taskMode" in parsed ||
    (parsed.resetSeed && typeof parsed.resetSeed === "object" && !Array.isArray(parsed.resetSeed)
      ? "pendingPrompt" in parsed.resetSeed || "taskMode" in parsed.resetSeed
      : false)
  );
}

function migrateManifest(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "skip", reason: "JSON root is not an object" };
  }
  if (!("schemaVersion" in parsed)) {
    return { kind: "skip", reason: "missing schemaVersion" };
  }

  if (parsed.schemaVersion === 7) {
    if (typeof parsed.brief !== "string") {
      return { kind: "error", reason: "schemaVersion 7 manifest is missing brief string" };
    }
    if (
      !parsed.resetSeed ||
      typeof parsed.resetSeed !== "object" ||
      Array.isArray(parsed.resetSeed)
    ) {
      return { kind: "error", reason: "schemaVersion 7 manifest is missing resetSeed object" };
    }
    if (typeof parsed.resetSeed.brief !== "string") {
      return {
        kind: "error",
        reason: "schemaVersion 7 manifest is missing resetSeed.brief string",
      };
    }
    if (!Array.isArray(parsed.sessions)) {
      return { kind: "error", reason: "schemaVersion 7 manifest is missing sessions array" };
    }
    if (
      parsed.sessions.some(
        (session) =>
          !session ||
          typeof session !== "object" ||
          Array.isArray(session) ||
          typeof session.brief !== "string",
      )
    ) {
      return {
        kind: "error",
        reason: "schemaVersion 7 manifest has a session missing brief string",
      };
    }
    if (!hasLegacyPromptFields(parsed)) {
      return { kind: "noop", manifest: parsed };
    }

    const { pendingPrompt: _pendingPrompt, taskMode: _taskMode, resetSeed, ...rest } = parsed;
    const {
      pendingPrompt: _seedPendingPrompt,
      taskMode: _seedTaskMode,
      ...cleanResetSeed
    } = resetSeed;
    return {
      kind: "change",
      manifest: {
        ...rest,
        resetSeed: cleanResetSeed,
      },
    };
  }

  if (parsed.schemaVersion !== 6) {
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
    return { kind: "error", reason: "schemaVersion 6 manifest is missing resetSeed object" };
  }
  if (!Array.isArray(parsed.sessions)) {
    return { kind: "error", reason: "schemaVersion 6 manifest is missing sessions array" };
  }

  let manifestBrief;
  let resetSeedBrief;
  try {
    manifestBrief = deriveManifestBrief(parsed);
    resetSeedBrief = deriveResetSeedBrief(parsed, manifestBrief);
  } catch (error) {
    return { kind: "error", reason: error.message };
  }

  let sessions;
  try {
    sessions = parsed.sessions.map((session) => ({
      ...session,
      brief: deriveSessionBrief(parsed, session, manifestBrief),
    }));
  } catch (error) {
    return { kind: "error", reason: error.message };
  }

  const { pendingPrompt: _pendingPrompt, taskMode: _taskMode, resetSeed, ...rest } = parsed;
  const { pendingPrompt: _seedPendingPrompt, taskMode: _seedTaskMode, ...seedRest } = resetSeed;

  return {
    kind: "change",
    manifest: {
      ...rest,
      schemaVersion: 7,
      brief: manifestBrief,
      resetSeed: {
        ...seedRest,
        brief: resetSeedBrief,
      },
      sessions,
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
      process.stdout.write(`OK    ${manifestPath}: already schemaVersion 7 with briefs\n`);
      continue;
    }

    changedCount += 1;
    if (options.write) {
      writeJsonAtomic(manifestPath, result.manifest);
      process.stdout.write(`WRITE ${manifestPath}: updated to schemaVersion 7 with briefs\n`);
    } else {
      process.stdout.write(`DRY   ${manifestPath}: would update to schemaVersion 7 with briefs\n`);
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
