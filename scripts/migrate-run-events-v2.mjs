#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

function usage() {
  return [
    "Usage: node scripts/migrate-run-events-v2.mjs [--root <path>] [--repo <name>]... [--write]",
    "",
    "Dry-run by default. Use --write to rewrite run-events.jsonl files in place.",
    "Migrates schemaVersion 1 run audit rows to schemaVersion 2 with canonical per-run cursors.",
    "Pass a state root such as ~/.local/state/task-runner with --root.",
    "Use repeated --repo filters to limit migration to selected repo buckets.",
    "Malformed or unparseable rows are skipped and reported; they do not fail migration.",
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

function isOptionalInteger(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0);
}

function repoFromRunEventsPath(runEventsPath) {
  const repoDir = dirname(dirname(runEventsPath));
  return basename(repoDir);
}

function classifyRow(parsed, lineNumber) {
  if (!isObjectRecord(parsed)) {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: JSON root is not an object`,
    };
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: unsupported schemaVersion ${String(parsed.schemaVersion)}`,
    };
  }
  if (typeof parsed.recordedAt !== "string") {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: missing recordedAt string`,
    };
  }
  if (typeof parsed.runId !== "string") {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: missing runId string`,
    };
  }
  if (typeof parsed.eventType !== "string") {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: missing eventType string`,
    };
  }
  if (typeof parsed.source !== "string") {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: missing source string`,
    };
  }
  if (parsed.hostMode !== "embedded" && parsed.hostMode !== "daemon") {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: invalid hostMode ${String(parsed.hostMode)}`,
    };
  }
  if (
    parsed.controllerInstanceId !== undefined &&
    typeof parsed.controllerInstanceId !== "string"
  ) {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: invalid controllerInstanceId`,
    };
  }
  if (!isOptionalInteger(parsed.sessionIndex)) {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: invalid sessionIndex`,
    };
  }
  if (!isOptionalInteger(parsed.attempt)) {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: invalid attempt`,
    };
  }
  if (parsed.schemaVersion === 2 && !(Number.isInteger(parsed.cursor) && parsed.cursor > 0)) {
    return {
      kind: "malformed",
      reason: `line ${lineNumber}: invalid cursor`,
    };
  }

  return {
    kind: "valid",
    record: parsed,
  };
}

function migrateRecord(record, cursor) {
  const {
    schemaVersion: _schemaVersion,
    cursor: _cursor,
    recordedAt,
    runId,
    eventType,
    source,
    hostMode,
    controllerInstanceId,
    sessionIndex,
    attempt,
    ...fields
  } = record;

  return {
    schemaVersion: 2,
    recordedAt,
    cursor,
    runId,
    eventType,
    source,
    hostMode,
    ...(controllerInstanceId !== undefined ? { controllerInstanceId } : {}),
    ...(sessionIndex !== undefined ? { sessionIndex } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...fields,
  };
}

function migrateRunEventsFile(runEventsPath) {
  const raw = readFileSync(runEventsPath, "utf8");
  const lines = raw.length === 0 ? [] : raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const nextCursorByRunId = new Map();
  const migratedRecords = [];
  const malformed = [];
  let unchangedRows = 0;

  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      malformed.push(`line ${index + 1}: invalid JSON (${error.message})`);
      continue;
    }

    const classified = classifyRow(parsed, index + 1);
    if (classified.kind === "malformed") {
      malformed.push(classified.reason);
      continue;
    }

    const currentCursor = nextCursorByRunId.get(classified.record.runId) ?? 1;
    const migrated = migrateRecord(classified.record, currentCursor);
    nextCursorByRunId.set(classified.record.runId, currentCursor + 1);
    if (isDeepStrictEqual(classified.record, migrated)) {
      unchangedRows += 1;
    }
    migratedRecords.push(migrated);
  }

  if (
    malformed.length === 0 &&
    migratedRecords.length === lines.length &&
    unchangedRows === lines.length
  ) {
    return {
      kind: "noop",
      records: migratedRecords,
      malformed,
    };
  }

  return {
    kind: "change",
    records: migratedRecords,
    malformed,
  };
}

function writeJsonLinesAtomic(path, records) {
  const tempDir = mkdtempSync(join(dirname(path), ".run-events-migrate-"));
  const tempPath = join(tempDir, basename(path));
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(tempPath, body.length === 0 ? "" : `${body}\n`);
  renameSync(tempPath, path);
  rmSync(tempDir, { recursive: true, force: true });
}

function formatCanonicalizedMessage(result, verb) {
  const malformedSuffix =
    result.malformed.length > 0 ? `; skipped ${result.malformed.length} malformed` : "";
  return `${verb} ${result.records.length} rows to schemaVersion 2${malformedSuffix}`;
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

  const runEventsFiles = [];
  const runsRoot = join(options.root, "runs");

  try {
    for (const path of walk(runsRoot)) {
      if (basename(path) === "run-events.jsonl") {
        runEventsFiles.push(path);
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

  for (const runEventsPath of runEventsFiles.sort()) {
    const repo = repoFromRunEventsPath(runEventsPath);
    if (selectedRepos && !selectedRepos.has(repo)) {
      skippedCount += 1;
      process.stdout.write(`SKIP  ${runEventsPath}: repo bucket ${repo} not selected\n`);
      continue;
    }

    let result;
    try {
      result = migrateRunEventsFile(runEventsPath);
    } catch (error) {
      errorCount += 1;
      process.stderr.write(`ERROR ${runEventsPath}: ${error.message}\n`);
      continue;
    }

    if (result.kind === "noop") {
      noopCount += 1;
      process.stdout.write(
        `OK    ${runEventsPath}: already canonical schemaVersion 2 audit rows\n`,
      );
      continue;
    }

    changedCount += 1;
    if (options.write) {
      writeJsonLinesAtomic(runEventsPath, result.records);
      process.stdout.write(
        `WRITE ${runEventsPath}: ${formatCanonicalizedMessage(result, "canonicalized")}\n`,
      );
    } else {
      process.stdout.write(
        `DRY   ${runEventsPath}: would ${formatCanonicalizedMessage(result, "canonicalize")}\n`,
      );
    }
  }

  process.stdout.write(
    [
      "",
      `Scanned: ${runEventsFiles.length}`,
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
