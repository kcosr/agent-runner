#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

function usage() {
  return [
    "Usage: node scripts/migrate-manifests-v11.mjs [--root <path>] [--repo <name>]... [--write]",
    "",
    "Dry-run by default. Use --write to update manifests and attempt logs in place.",
    "Migrates schemaVersion 10 manifests to 11 and canonicalizes repairable schemaVersion 11 manifests.",
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
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { root, write, repos };
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value) {
  return isObjectRecord(value) ? structuredClone(value) : {};
}

function cloneArray(value) {
  return Array.isArray(value) ? value.map((entry) => structuredClone(entry)) : [];
}

function optionalStringOrNull(value, field) {
  if (value === null || typeof value === "string") return value;
  throw new Error(`${field} must be a string or null`);
}

function optionalNumberOrNull(value, field) {
  if (value === null || typeof value === "number") return value;
  throw new Error(`${field} must be a number or null`);
}

function requireNumber(value, field) {
  if (typeof value !== "number") {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function attemptLogRelativePath(attemptNumber) {
  return `attempts/${String(attemptNumber).padStart(2, "0")}.json`;
}

function atomicWriteJson(path, value) {
  const tmpDir = mkdtempSync(join(dirname(path), ".migrate-v11-"));
  const tmpPath = join(tmpDir, basename(path));
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmpPath, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function normalizeResetSeed(parsed, maxAttemptsPerSession) {
  const current = isObjectRecord(parsed.resetSeed) ? parsed.resetSeed : {};
  const { maxAttempts: _oldMaxAttempts, ...rest } = current;
  return {
    ...rest,
    maxAttemptsPerSession:
      typeof current.maxAttemptsPerSession === "number"
        ? current.maxAttemptsPerSession
        : maxAttemptsPerSession,
  };
}

function normalizeSessions(parsed, maxAttemptsPerSession) {
  const sessions = cloneArray(parsed.sessions);
  return sessions.map((session, index) => {
    if (!isObjectRecord(session)) {
      throw new Error(`sessions[${index}] must be an object`);
    }
    const {
      firstAttempt: _firstAttempt,
      lastAttempt: _lastAttempt,
      maxAttempts: _maxAttempts,
      ...rest
    } = session;
    return {
      ...rest,
      sessionIndex: requireNumber(session.sessionIndex, `sessions[${index}].sessionIndex`),
      startedAt: requireString(session.startedAt, `sessions[${index}].startedAt`),
      endedAt: optionalStringOrNull(session.endedAt, `sessions[${index}].endedAt`),
      status: requireString(session.status, `sessions[${index}].status`),
      exitCode: optionalNumberOrNull(session.exitCode, `sessions[${index}].exitCode`),
      message: optionalStringOrNull(session.message, `sessions[${index}].message`),
      brief: requireString(session.brief, `sessions[${index}].brief`),
      firstAttemptNumber: optionalNumberOrNull(
        session.firstAttemptNumber !== undefined
          ? session.firstAttemptNumber
          : session.firstAttempt,
        `sessions[${index}].firstAttemptNumber`,
      ),
      lastAttemptNumber: optionalNumberOrNull(
        session.lastAttemptNumber !== undefined ? session.lastAttemptNumber : session.lastAttempt,
        `sessions[${index}].lastAttemptNumber`,
      ),
      maxAttemptsPerSession:
        typeof session.maxAttemptsPerSession === "number"
          ? session.maxAttemptsPerSession
          : typeof session.maxAttempts === "number"
            ? session.maxAttempts
            : maxAttemptsPerSession,
      backendSessionIdAtStart: optionalStringOrNull(
        session.backendSessionIdAtStart,
        `sessions[${index}].backendSessionIdAtStart`,
      ),
      backendSessionIdAtEnd: optionalStringOrNull(
        session.backendSessionIdAtEnd,
        `sessions[${index}].backendSessionIdAtEnd`,
      ),
    };
  });
}

function normalizeAttemptRecords(parsed) {
  const records = cloneArray(parsed.attemptRecords);
  const counters = new Map();
  return records
    .map((record, index) => {
      if (!isObjectRecord(record)) {
        throw new Error(`attemptRecords[${index}] must be an object`);
      }
      const {
        attempt: _oldAttempt,
        attemptIndexInSession: _oldIndex,
        tasksAfter: _oldTasksAfter,
        ...rest
      } = record;
      const attemptNumber =
        typeof record.attemptNumber === "number"
          ? record.attemptNumber
          : requireNumber(record.attempt, `attemptRecords[${index}].attempt`);
      const sessionIndex = requireNumber(
        record.sessionIndex,
        `attemptRecords[${index}].sessionIndex`,
      );
      return {
        ...rest,
        attemptNumber,
        sessionIndex,
        startedAt: requireString(record.startedAt, `attemptRecords[${index}].startedAt`),
        endedAt: requireString(record.endedAt, `attemptRecords[${index}].endedAt`),
        prompt: requireString(record.prompt, `attemptRecords[${index}].prompt`),
        sessionIdAtStart: optionalStringOrNull(
          record.sessionIdAtStart,
          `attemptRecords[${index}].sessionIdAtStart`,
        ),
        sessionIdCaptured: optionalStringOrNull(
          record.sessionIdCaptured,
          `attemptRecords[${index}].sessionIdCaptured`,
        ),
        exitCode: optionalNumberOrNull(record.exitCode, `attemptRecords[${index}].exitCode`),
        signal: optionalStringOrNull(record.signal, `attemptRecords[${index}].signal`),
        timedOut: record.timedOut === true,
        transcript: optionalStringOrNull(record.transcript, `attemptRecords[${index}].transcript`),
        logPath:
          typeof record.logPath === "string"
            ? record.logPath
            : attemptLogRelativePath(attemptNumber),
        invalidStatuses: cloneArray(record.invalidStatuses),
      };
    })
    .sort((a, b) => a.attemptNumber - b.attemptNumber)
    .map((record) => {
      const attemptIndexInSession = counters.get(record.sessionIndex) ?? 0;
      counters.set(record.sessionIndex, attemptIndexInSession + 1);
      return { ...record, attemptIndexInSession };
    });
}

function normalizeHookAudits(parsed) {
  return cloneArray(parsed.hookAudits).map((audit, index) => {
    if (!isObjectRecord(audit)) {
      throw new Error(`hookAudits[${index}] must be an object`);
    }
    const { attempt: _oldAttempt, ...rest } = audit;
    return {
      ...rest,
      phase: requireString(audit.phase, `hookAudits[${index}].phase`),
      hookId: requireString(audit.hookId, `hookAudits[${index}].hookId`),
      startedAt: requireString(audit.startedAt, `hookAudits[${index}].startedAt`),
      endedAt: requireString(audit.endedAt, `hookAudits[${index}].endedAt`),
      outcome: requireString(audit.outcome, `hookAudits[${index}].outcome`),
      sessionIndex: optionalNumberOrNull(audit.sessionIndex, `hookAudits[${index}].sessionIndex`),
      attemptNumber: optionalNumberOrNull(
        audit.attemptNumber !== undefined ? audit.attemptNumber : audit.attempt,
        `hookAudits[${index}].attemptNumber`,
      ),
      taskId: optionalStringOrNull(audit.taskId, `hookAudits[${index}].taskId`),
      summary: optionalStringOrNull(audit.summary, `hookAudits[${index}].summary`),
    };
  });
}

function normalizeAttemptLog(workspaceDir, manifestRunId, record) {
  const workspaceRoot = resolve(workspaceDir);
  const logPath = resolve(workspaceRoot, record.logPath);
  if (logPath !== workspaceRoot && !logPath.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`${record.logPath} escapes workspace ${workspaceDir}`);
  }
  const raw = readFileSync(logPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!isObjectRecord(parsed)) {
    throw new Error(`${record.logPath} root is not an object`);
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    throw new Error(`${record.logPath} has unsupported schemaVersion ${parsed.schemaVersion}`);
  }
  const attemptNumber =
    typeof parsed.attemptNumber === "number"
      ? parsed.attemptNumber
      : requireNumber(parsed.attempt, `${record.logPath}.attempt`);
  if (attemptNumber !== record.attemptNumber) {
    throw new Error(`${record.logPath} attempt number does not match attempt record`);
  }
  const sessionIndex = requireNumber(parsed.sessionIndex, `${record.logPath}.sessionIndex`);
  if (sessionIndex !== record.sessionIndex) {
    throw new Error(`${record.logPath} sessionIndex does not match attempt record`);
  }
  return {
    path: logPath,
    next: {
      schemaVersion: 2,
      runId: manifestRunId,
      attemptNumber: record.attemptNumber,
      sessionIndex: record.sessionIndex,
      attemptIndexInSession: record.attemptIndexInSession,
      startedAt:
        typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : requireString(record.startedAt, "startedAt"),
      endedAt:
        typeof parsed.endedAt === "string"
          ? parsed.endedAt
          : requireString(record.endedAt, "endedAt"),
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
    },
    previous: parsed,
  };
}

function normalizeManifest(parsed, workspaceDir) {
  if (!isObjectRecord(parsed)) {
    return { kind: "skip", reason: "JSON root is not an object" };
  }
  if (!("schemaVersion" in parsed)) {
    return { kind: "skip", reason: "missing schemaVersion" };
  }
  if (parsed.schemaVersion !== 10 && parsed.schemaVersion !== 11) {
    return { kind: "skip", reason: `schemaVersion ${parsed.schemaVersion} is not targeted` };
  }

  const maxAttemptsPerSession =
    typeof parsed.maxAttemptsPerSession === "number"
      ? parsed.maxAttemptsPerSession
      : requireNumber(parsed.maxAttempts, "maxAttempts");
  const sessions = normalizeSessions(parsed, maxAttemptsPerSession);
  const attemptRecords = normalizeAttemptRecords(parsed);
  const hookAudits = normalizeHookAudits(parsed);
  const {
    attempts: _oldAttempts,
    maxAttempts: _oldMaxAttempts,
    sessionCount: _oldSessionCount,
    ...rest
  } = parsed;
  const next = {
    ...rest,
    schemaVersion: 11,
    totalAttemptCount: attemptRecords.length,
    maxAttemptsPerSession,
    totalSessionCount: sessions.length,
    resetSeed: normalizeResetSeed(parsed, maxAttemptsPerSession),
    sessions,
    attemptRecords,
    hookAudits,
  };
  const logs = attemptRecords.map((record) =>
    normalizeAttemptLog(workspaceDir, next.runId, record),
  );
  return { kind: "target", next, logs };
}

function* manifestPaths(runsRoot, repoFilter) {
  for (const repoEntry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!repoEntry.isDirectory()) continue;
    if (repoFilter.size > 0 && !repoFilter.has(repoEntry.name)) continue;

    const repoDir = join(runsRoot, repoEntry.name);
    for (const runEntry of readdirSync(repoDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      const runDir = join(repoDir, runEntry.name);
      const manifestEntry = readdirSync(runDir, { withFileTypes: true }).find(
        (entry) => entry.isFile() && entry.name === "run.json",
      );
      if (manifestEntry) {
        yield join(runDir, manifestEntry.name);
      }
    }
  }
}

function run() {
  const opts = parseArgs(process.argv.slice(2));
  const runsRoot = join(opts.root, "runs");
  const repoFilter = new Set(opts.repos);
  const summary = { ok: 0, dry: 0, write: 0, skip: 0, error: 0 };

  for (const manifestPath of manifestPaths(runsRoot, repoFilter)) {
    const rel = manifestPath.slice(opts.root.length + 1);
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      const result = normalizeManifest(parsed, dirname(manifestPath));
      if (result.kind === "skip") {
        summary.skip += 1;
        process.stdout.write(`SKIP ${rel}: ${result.reason}\n`);
        continue;
      }
      const manifestChanged = !isDeepStrictEqual(parsed, result.next);
      const changedLogs = result.logs.filter((log) => !isDeepStrictEqual(log.previous, log.next));
      if (!manifestChanged && changedLogs.length === 0) {
        summary.ok += 1;
        process.stdout.write(`OK   ${rel}: already canonical schemaVersion 11 state\n`);
        continue;
      }
      if (!opts.write) {
        summary.dry += 1;
        process.stdout.write(
          `DRY  ${rel}: would ${parsed.schemaVersion === 10 ? "promote to" : "canonicalize"} schemaVersion 11 state\n`,
        );
        continue;
      }
      for (const log of changedLogs) {
        atomicWriteJson(log.path, log.next);
      }
      if (manifestChanged) {
        atomicWriteJson(manifestPath, result.next);
      }
      summary.write += 1;
      process.stdout.write(
        `WRITE ${rel}: ${parsed.schemaVersion === 10 ? "promoted to" : "canonicalized"} schemaVersion 11 state\n`,
      );
    } catch (error) {
      summary.error += 1;
      process.stdout.write(
        `ERROR ${rel}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  process.stdout.write(
    `Summary: OK=${summary.ok} DRY=${summary.dry} WRITE=${summary.write} SKIP=${summary.skip} ERROR=${summary.error}\n`,
  );
  if (summary.error > 0) {
    process.exitCode = 1;
  }
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
}
