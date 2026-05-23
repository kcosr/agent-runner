import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { DaemonClient, DaemonRpcError } from "../apps/cli/dist/daemon/client.js";
import { deriveHttpBaseUrl } from "../apps/cli/dist/daemon/config.js";
import {
  daemonGetRunAuditHistory,
  daemonReconfigureRun,
} from "../apps/cli/dist/daemon/http-client.js";
import { RPC_ERROR_COMMAND } from "../apps/cli/dist/daemon/protocol.js";
import { serveDaemon } from "../apps/cli/dist/daemon/server.js";
import { streamEvents } from "../apps/cli/dist/daemon/sse.js";
import {
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_INITIAL_WINDOW_BYTES,
  STREAM_MAX_ACTIVE_PER_CONNECTION,
  STREAM_MAX_BUFFERED_BYTES_PER_CONNECTION,
  STREAM_MAX_BUFFERED_BYTES_PER_STREAM,
  STREAM_MAX_CHUNK_BYTES,
  WebSocketStreamError,
  WebSocketStreamRegistry,
} from "../apps/cli/dist/daemon/stream.js";
import {
  getRun as getRunDetail,
  queueResumeMessage as queueResumeMessageCommand,
  removeQueuedResumeMessage as removeQueuedResumeMessageCommand,
} from "../packages/core/dist/app/service.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { ResumeError } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withTaskStateLock } from "../packages/core/dist/core/run/workspace-state.js";
import { freePort, startCliDaemon as startCliDaemonProcess } from "./helpers/daemon-process.mjs";
import { sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);
const CLI_WEB_ROOT = resolvePath(new URL("../apps/cli/dist/web", import.meta.url).pathname);

function startCliDaemon(baseDir, listenUrl, opts = {}) {
  return startCliDaemonProcess(baseDir, listenUrl, CLI_PATH, opts);
}

const AGENT = `---
schemaVersion: 1
name: daemon-agent
backend: claude
model: claude-sonnet-4-6
---
Daemon agent.
`;

const PASSIVE_AGENT = `---
schemaVersion: 1
name: passive-daemon-agent
backend: passive
---
Passive daemon agent.
`;

const CODEX_AGENT = `---
schemaVersion: 1
name: codex-daemon-agent
backend: codex
---
Codex daemon agent for {{target}}.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: daemon-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Daemon assignment.
`;

const SYNC_AGENT = `---
schemaVersion: 1
name: sync-daemon-agent
backend: syncer
---
Sync daemon agent.
`;

const RECONFIG_ASSIGNMENT = `---
schemaVersion: 1
name: reconfig-work
message: original message
vars:
  target:
    type: string
    required: true
tasks:
  - id: t1
    title: Handle {{target}}
    body: Message for {{target}}.
---
Reconfig assignment for {{target}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-daemon-"));
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initGitRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "agent-runner@example.invalid"]);
  git(dir, ["config", "user.name", "Agent Runner"]);
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), body);
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assignment.md"), body);
}

function writeTask(baseDir, name, body) {
  const path = join(baseDir, "tasks", `${name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
}

function writeBackend(baseDir, name, body) {
  const dir = join(baseDir, "backends", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "backend.mjs"), body);
}

function writeSyncBackend(baseDir) {
  writeBackend(
    baseDir,
    "syncer",
    `
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.AGENT_RUNNER_SYNC_BACKEND_STATE;

function readState() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
}

export default {
  id: "syncer",
  async invoke() {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      sessionId: "sync-session",
      transcript: "ok",
      rawStdout: "",
      rawStderr: "",
    };
  },
  async resolveSessionHistorySource() {
    const state = readState();
    state.resolveCalls = (state.resolveCalls ?? 0) + 1;
    writeState(state);
    if (state.available === false) {
      return { available: false, reason: "not available" };
    }
    return {
      available: true,
      source: {
        kind: "custom",
        label: "sync-fixture",
        changeToken: { token: state.token },
      },
    };
  },
  async readSessionHistory() {
    const state = readState();
    state.readCalls = (state.readCalls ?? 0) + 1;
    writeState(state);
    if (state.readDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, state.readDelayMs));
    }
    if (state.failRead === true) {
      throw new Error("fixture read failed");
    }
    return {
      source: {
        kind: "custom",
        label: "sync-fixture",
        changeToken: { token: state.token },
      },
      cursor: { token: state.token },
      turns: state.turns,
    };
  },
};
`,
  );
}

function writeSyncState(path, patch = {}) {
  const previous = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { token: "v1", turns: [], resolveCalls: 0, readCalls: 0 };
  writeFileSync(path, `${JSON.stringify({ ...previous, ...patch }, null, 2)}\n`);
}

function readSyncState(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function makeSyncedTurn(id, startedAt = "2026-04-26T10:00:00.000Z") {
  return {
    backendTurnId: id,
    status: "complete",
    startedAt,
    updatedAt: "2026-04-26T10:01:00.000Z",
    userText: `prompt ${id}`,
    assistantText: `answer ${id}`,
  };
}

async function initRun(baseDir, agentName = "daemon-agent", options = {}) {
  return withEnv(sharedRuntimeEnv(baseDir), async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = loadAssignmentConfig("daemon-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        webVars: {},
        parentRunId: options.parentRunId ?? null,
        backend: {
          id: loaded.config.backend,
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
        initialize: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function patchManifest(workspaceDir, mutator) {
  withTaskStateLock(workspaceDir, () => {
    const manifestPath = join(workspaceDir, "run.json");
    const manifest = readManifest(workspaceDir);
    mutator(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });
}

function moveRunToRepoBucket(baseDir, workspaceDir, repo, options = {}) {
  const runId = options.runId ?? readManifest(workspaceDir).runId;
  const nextWorkspaceDir = join(baseDir, "runs", repo, runId);
  mkdirSync(dirname(nextWorkspaceDir), { recursive: true });
  renameSync(workspaceDir, nextWorkspaceDir);
  patchManifest(nextWorkspaceDir, (manifest) => {
    manifest.runId = runId;
    manifest.repo = repo;
    manifest.cwd = options.cwd ?? join(baseDir, repo);
    manifest.workspaceDir = nextWorkspaceDir;
  });
  return nextWorkspaceDir;
}

function markRunRunning(workspaceDir) {
  patchManifest(workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.totalAttemptCount = Math.max(manifest.totalAttemptCount, 1);
    manifest.totalSessionCount = Math.max(manifest.totalSessionCount, 1);
  });
}

function markRunSuccessful(workspaceDir) {
  patchManifest(workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.endedAt ??= "2026-04-21T12:05:00.000Z";
    manifest.exitCode = 0;
    manifest.totalAttemptCount = Math.max(manifest.totalAttemptCount, 1);
    manifest.tasksCompleted = manifest.tasksTotal;
    for (const task of Object.values(manifest.finalTasks)) {
      task.status = "completed";
    }
  });
}

function setSyntheticSession(workspaceDir, options = {}) {
  const sessionIndex = options.sessionIndex ?? 0;
  patchManifest(workspaceDir, (manifest) => {
    manifest.status = options.status ?? "running";
    manifest.endedAt = options.endedAt ?? null;
    manifest.exitCode = options.exitCode ?? null;
    manifest.totalSessionCount = Math.max(manifest.totalSessionCount, sessionIndex + 1);
    const existingIndex = manifest.sessions.findIndex(
      (session) => session.sessionIndex === sessionIndex,
    );
    const session = {
      sessionIndex,
      startedAt: options.startedAt ?? "2026-04-21T12:00:00.000Z",
      endedAt: options.sessionEndedAt ?? null,
      status: options.sessionStatus ?? manifest.status,
      exitCode: options.sessionExitCode ?? manifest.exitCode,
      message: options.message ?? null,
      brief: options.brief ?? manifest.brief,
      firstAttemptNumber: options.firstAttemptNumber ?? null,
      lastAttemptNumber: options.lastAttemptNumber ?? null,
      maxAttemptsPerSession: manifest.maxAttemptsPerSession,
      backendSessionIdAtStart: options.backendSessionIdAtStart ?? manifest.backendSessionId,
      backendSessionIdAtEnd: options.backendSessionIdAtEnd ?? null,
      resumeSource: options.resumeSource ?? null,
      provenance: { kind: "task_runner" },
    };
    if (existingIndex >= 0) {
      manifest.sessions[existingIndex] = session;
    } else {
      manifest.sessions.push(session);
    }
  });
}

function completeSyntheticSession(workspaceDir, options = {}) {
  const sessionIndex = options.sessionIndex ?? 0;
  const status = options.status ?? "success";
  const exitCode = options.exitCode ?? (status === "success" ? 0 : status === "blocked" ? 2 : 4);
  patchManifest(workspaceDir, (manifest) => {
    manifest.status = status;
    manifest.endedAt = options.endedAt ?? "2026-04-21T12:05:00.000Z";
    manifest.exitCode = exitCode;
    manifest.tasksCompleted = status === "success" ? manifest.tasksTotal : manifest.tasksCompleted;
    if (status === "success") {
      for (const task of Object.values(manifest.finalTasks)) {
        task.status = "completed";
      }
    }
    const attemptNumber =
      options.attemptNumber ??
      Math.max(0, ...manifest.attemptRecords.map((record) => record.attemptNumber)) + 1;
    const session = manifest.sessions.find((record) => record.sessionIndex === sessionIndex);
    if (session) {
      session.endedAt = options.sessionEndedAt ?? manifest.endedAt;
      session.status = status;
      session.exitCode = exitCode;
      session.firstAttemptNumber ??= attemptNumber;
      session.lastAttemptNumber = attemptNumber;
      session.backendSessionIdAtEnd = manifest.backendSessionId;
    } else {
      manifest.sessions.push({
        sessionIndex,
        startedAt: options.startedAt ?? "2026-04-21T12:00:00.000Z",
        endedAt: options.sessionEndedAt ?? manifest.endedAt,
        status,
        exitCode,
        message: options.message ?? null,
        brief: options.brief ?? manifest.brief,
        firstAttemptNumber: attemptNumber,
        lastAttemptNumber: attemptNumber,
        maxAttemptsPerSession: manifest.maxAttemptsPerSession,
        backendSessionIdAtStart: manifest.backendSessionId,
        backendSessionIdAtEnd: manifest.backendSessionId,
        resumeSource: options.resumeSource ?? null,
        provenance: { kind: "task_runner" },
      });
    }
    manifest.attemptRecords = manifest.attemptRecords.filter(
      (record) => record.attemptNumber !== attemptNumber,
    );
    manifest.attemptRecords.push({
      attemptNumber,
      sessionIndex,
      attemptIndexInSession: options.attemptIndexInSession ?? 0,
      startedAt: options.startedAt ?? "2026-04-21T12:00:00.000Z",
      endedAt: options.endedAt ?? "2026-04-21T12:05:00.000Z",
      prompt: options.prompt ?? "synthetic prompt",
      sessionIdAtStart: null,
      sessionIdCaptured: null,
      exitCode,
      signal: null,
      timedOut: false,
      transcript: options.transcript ?? null,
      logPath: `attempts/${String(attemptNumber).padStart(2, "0")}.json`,
      invalidStatuses: [],
      provenance: { kind: "task_runner" },
    });
    manifest.totalAttemptCount = manifest.attemptRecords.length;
    manifest.totalSessionCount = manifest.sessions.length;
  });
}

function addPendingParentCompletionNotification(workspaceDir, options) {
  const notification = {
    id: options.id,
    parentRunId: options.parentRunId,
    sessionIndex: options.sessionIndex ?? 0,
    source: "detached_invocation",
    status: "pending",
    createdAt: options.createdAt ?? "2026-04-21T12:06:00.000Z",
    deliveredAt: null,
    terminalStatus: null,
    deliveryReason: null,
    failureReason: null,
  };
  patchManifest(workspaceDir, (manifest) => {
    manifest.parentCompletionNotifications.push(notification);
  });
  return notification;
}

function markRunReady(workspaceDir) {
  patchManifest(workspaceDir, (manifest) => {
    manifest.status = "ready";
    manifest.endedAt = null;
    manifest.exitCode = null;
  });
}

function setManifestSchedule(workspaceDir, schedule) {
  patchManifest(workspaceDir, (manifest) => {
    manifest.schedule = schedule;
  });
}

function oneTimeSchedule(runAt) {
  return {
    enabled: true,
    runAt: runAt.toISOString(),
    recurrence: null,
  };
}

function recurringSchedule(runAt, expression = "* * * * *") {
  return {
    enabled: true,
    runAt: runAt.toISOString(),
    recurrence: {
      schedule: {
        type: "cron",
        expression,
        timezone: "UTC",
      },
      mode: "reuse",
      continueOnFailure: false,
    },
  };
}

function emitRunStarted(emitEvent, runId, cwd) {
  emitEvent({
    type: "run_started",
    runId,
    agentName: "daemon-agent",
    assignmentSourcePath: null,
    name: "daemon-work",
    cwd,
    sessionIndex: 0,
  });
}

function emitRunFinished(emitEvent, runId, status = "success") {
  emitEvent({
    type: "run_finished",
    summary: {
      status,
      sessionAttemptCount: 1,
      totalAttemptCount: 1,
      maxAttemptsPerSession: 1,
      totalSessionCount: 1,
      tasksCompleted: 1,
      tasksTotal: 1,
      tasks: [],
      runId,
    },
  });
}

async function withSeededFrontendDist(fn) {
  const indexPath = join(CLI_WEB_ROOT, "index.html");
  const assetPath = join(CLI_WEB_ROOT, "assets", "daemon-test.js");
  const createdPaths = [];

  mkdirSync(join(CLI_WEB_ROOT, "assets"), { recursive: true });
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        "    <title>agent-runner</title>",
        '    <script type="module" src="/assets/daemon-test.js"></script>',
        "  </head>",
        '  <body><div id="root"></div></body>',
        "</html>",
        "",
      ].join("\n"),
    );
    createdPaths.push(indexPath);
  }
  if (!existsSync(assetPath)) {
    writeFileSync(assetPath, 'console.log("daemon test asset");\n');
    createdPaths.push(assetPath);
  }

  try {
    return await fn({ assetPath, indexPath });
  } finally {
    for (const path of createdPaths.reverse()) {
      rmSync(path, { force: true });
    }
  }
}

async function openRawWebSocket(listenUrl, options = {}) {
  const ws = new WebSocket(listenUrl, options);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function nextRawMessage(ws) {
  return await new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

class FakeStreamWebSocket {
  readyState = 1;
  sent = [];

  send(data, cb) {
    this.sent.push(JSON.parse(data));
    cb();
  }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function httpJson(baseUrl, path, opts = {}) {
  const response = await fetch(new URL(path, baseUrl), opts);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

async function openSse(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const response = await fetch(new URL(path, baseUrl), {
    headers: { accept: "text/event-stream", ...(options.headers ?? {}) },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) {
            continue;
          }
          return JSON.parse(dataLine.slice(6));
        }

        const { done, value } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended before next event");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
    async waitForClose() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // Connection teardown may surface as a stream read error instead of EOF.
      }
    },
  };
}

async function openSseFrames(baseUrl, path) {
  const controller = new AbortController();
  const response = await fetch(new URL(path, baseUrl), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const idLine = frame.split("\n").find((line) => line.startsWith("id: "));
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) {
            continue;
          }
          return {
            id: idLine ? idLine.slice(4) : null,
            data: JSON.parse(dataLine.slice(6)),
          };
        }

        const { done, value } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended before next frame");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

class FakeSseResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.destroyed = false;
    this.headers = new Map();
    this.writeResults = writeResults;
    this.writableEnded = false;
  }

  flushHeaders() {}

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk) {
    this.lastChunk = chunk;
    if (this.writeResults.length > 0) {
      return this.writeResults.shift();
    }
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

function runCli(args, opts = {}) {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()), ...(opts.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliExpectFail(args, opts = {}) {
  try {
    runCli(args, opts);
    throw new Error("expected CLI to fail");
  } catch (err) {
    if (err.status === undefined) throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

async function runCliAsync(args, opts = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()), ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { ...result, stdout, stderr };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForValue(read, description, options = {}) {
  const attempts = options.attempts ?? 50;
  const delayMs = options.delayMs ?? 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await sleep(delayMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForRunStatus(baseUrl, runId, expectedStatus) {
  return await waitForValue(async () => {
    const response = await httpJson(baseUrl, `/api/runs/${runId}`);
    assert.equal(response.status, 200);
    return response.body.run.status === expectedStatus ? response.body.run : null;
  }, `run ${runId} to reach ${expectedStatus}`);
}

function installFakeSsh(baseDir) {
  const binDir = join(baseDir, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "ssh");
  const modulePath = `${scriptPath}.mjs`;
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
exec node "${modulePath}" "$@"
`,
  );
  writeFileSync(
    modulePath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const args = process.argv.slice(2);
const mode = process.env.AGENT_RUNNER_FAKE_SSH_MODE ?? "proxy";
const logPath = process.env.AGENT_RUNNER_FAKE_SSH_LOG;
const forwardIndex = args.indexOf("-L");
const host = args.at(-1) ?? "";
const forward = forwardIndex >= 0 ? args[forwardIndex + 1] : "";

if (logPath) {
  appendFileSync(logPath, JSON.stringify({ args, host, forward }) + "\\n");
}

if (mode === "fail-auth") {
  process.stderr.write("Permission denied (publickey).\\n");
  process.exit(255);
}

const match = /^127\\.0\\.0\\.1:(\\d+):([^:]+):(\\d+)$/.exec(forward);
if (!match) {
  process.stderr.write("invalid -L forward\\n");
  process.exit(2);
}

const [, localPortRaw, targetHostRaw, targetPortRaw] = match;
const localPort = Number(localPortRaw);
const targetHost = process.env.AGENT_RUNNER_FAKE_SSH_TARGET_HOST ?? targetHostRaw;
const targetPort = Number(targetPortRaw);

const server = createServer((client) => {
  const upstream = connect({ host: targetHost, port: targetPort });
  client.pipe(upstream);
  upstream.pipe(client);
  upstream.on("error", () => {
    client.destroy();
  });
  client.on("error", () => {
    upstream.destroy();
  });
});

server.on("error", (err) => {
  if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") {
    process.stderr.write(\`bind [127.0.0.1]:\${localPort}: Address already in use\\n\`);
    process.exit(255);
  }
  process.stderr.write(\`\${err.message}\\n\`);
  process.exit(1);
});

server.listen(localPort, "127.0.0.1");

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
  );
  chmodSync(scriptPath, 0o755);
  return { binDir, scriptPath, modulePath };
}

function fakeSshEnv(binDir, extra = {}) {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

test("daemon rpc mirrors shared run and definition DTOs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAgent(dir, "passive-daemon-agent", PASSIVE_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const child = await initRun(dir, "daemon-agent", { parentRunId: init.runId });
  const passiveInit = await initRun(dir, "passive-daemon-agent");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "api.md"), "# API\n\nDaemon workspace text.\n");
  const otherCwd = join(dir, "other-cwd");
  mkdirSync(otherCwd, { recursive: true });
  patchManifest(init.workspaceDir, (manifest) => {
    manifest.cwd = otherCwd;
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const client = await DaemonClient.connect(listenUrl);
    try {
      const info = await client.call("daemon.info");
      assert.equal(info.listenUrl, listenUrl);
      assert.equal(info.pid, process.pid);
      assert.match(info.daemonInstanceId, new RegExp(`^daemon-${info.pid}-[0-9a-z]+$`));

      const runs = await client.call("runs.list", {});
      assert.ok(runs.runs.some((run) => run.runId === init.runId));
      assert.ok(runs.runs.some((run) => run.runId === passiveInit.runId));
      assert.equal(runs.runs.find((run) => run.runId === child.runId)?.parentRunId, init.runId);
      assert.equal(runs.runs.find((run) => run.runId === init.runId)?.runGroupId, init.runId);
      assert.equal(runs.runs.find((run) => run.runId === child.runId)?.runGroupId, init.runId);

      const cwdScoped = await client.call("runs.list", {
        scope: { kind: "cwd", cwd: otherCwd },
      });
      assert.deepEqual(
        cwdScoped.runs.map((run) => run.runId),
        [init.runId],
      );

      const globalScoped = await client.call("runs.list", {
        scope: { kind: "global" },
      });
      assert.ok(globalScoped.runs.some((run) => run.runId === init.runId));
      assert.ok(globalScoped.runs.some((run) => run.runId === passiveInit.runId));
      assert.deepEqual(runs.runs.find((run) => run.runId === init.runId)?.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.deepEqual(runs.runs.find((run) => run.runId === init.runId)?.capabilities, {
        canArchive: true,
        canUnarchive: false,
        canReset: true,
        canDelete: false,
        canReady: true,
        canResume: false,
        canAbort: false,
        abortReason: "not_active_in_daemon",
        canReconfigure: true,
        taskMutation: {
          canSetStatus: true,
          canEditNotes: true,
          canAdd: true,
          canEditPending: true,
          canDeletePending: true,
        },
      });
      assert.deepEqual(runs.runs.find((run) => run.runId === init.runId)?.dependencyState, {
        ready: true,
        total: 0,
        satisfied: 0,
        unsatisfied: 0,
      });

      const detail = await client.call("runs.get", { target: init.runId });
      assert.equal(detail.run.runId, init.runId);
      assert.equal(detail.run.assignment.name, "daemon-work");
      assert.equal(detail.run.name, null);
      assert.deepEqual(detail.run.dependencies, []);
      assert.deepEqual(detail.run.dependents, []);
      assert.deepEqual(detail.run.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(detail.run.capabilities.canAbort, false);
      assert.equal(detail.run.capabilities.abortReason, "not_active_in_daemon");
      assert.equal(detail.run.capabilities.canReady, true);
      assert.equal(detail.run.capabilities.canResume, false);

      const childDetail = await client.call("runs.get", { target: child.runId });
      assert.equal(childDetail.run.parentRunId, init.runId);

      const dependency = await initRun(dir);
      const addedDependency = await client.call("runs.addDependency", {
        target: init.runId,
        dependency: { type: "run", runId: dependency.runId },
      });
      assert.deepEqual(addedDependency.result, {
        runId: init.runId,
        dependencies: [{ type: "run", runId: dependency.runId }],
        updatedAt: addedDependency.result.updatedAt,
        changed: true,
      });

      const removedDependency = await client.call("runs.removeDependency", {
        target: init.runId,
        dependency: { type: "run", runId: dependency.runId },
      });
      assert.deepEqual(removedDependency.result, {
        runId: init.runId,
        dependencies: [],
        updatedAt: removedDependency.result.updatedAt,
        changed: true,
      });

      const clearedDependencies = await client.call("runs.clearDependencies", {
        target: init.runId,
      });
      assert.deepEqual(clearedDependencies.result, {
        runId: init.runId,
        dependencies: [],
        updatedAt: removedDependency.result.updatedAt,
        changed: false,
      });

      const renamed = await client.call("runs.setName", {
        target: init.runId,
        name: "RPC renamed run",
      });
      assert.deepEqual(renamed.result, {
        runId: init.runId,
        name: "RPC renamed run",
        updatedAt: renamed.result.updatedAt,
        changed: true,
      });

      const renamedDetail = await client.call("runs.get", { target: init.runId });
      assert.equal(renamedDetail.run.name, "RPC renamed run");

      const cleared = await client.call("runs.setName", {
        target: init.runId,
        name: null,
      });
      assert.deepEqual(cleared.result, {
        runId: init.runId,
        name: null,
        updatedAt: cleared.result.updatedAt,
        changed: true,
      });

      const noted = await client.call("runs.setNote", {
        target: init.runId,
        note: "RPC note for the shared editor",
      });
      assert.deepEqual(noted.result, {
        runId: init.runId,
        note: "RPC note for the shared editor",
        updatedAt: noted.result.updatedAt,
        changed: true,
      });

      const pinned = await client.call("runs.setPinned", {
        target: init.runId,
        pinned: true,
      });
      assert.deepEqual(pinned.result, {
        runId: init.runId,
        pinned: true,
        updatedAt: pinned.result.updatedAt,
        changed: true,
      });

      const notedDetail = await client.call("runs.get", { target: init.runId });
      assert.equal(notedDetail.run.note, "RPC note for the shared editor");
      assert.equal(notedDetail.run.pinned, true);
      const notedSummary = (await client.call("runs.list", {})).runs.find(
        (run) => run.runId === init.runId,
      );
      assert.equal(notedSummary?.notePresent, true);
      assert.equal(notedSummary?.pinned, true);

      const setBackendSession = await client.call("runs.setBackendSession", {
        target: passiveInit.runId,
        backendSessionId: "rpc-thread-9",
      });
      assert.deepEqual(setBackendSession.result, {
        runId: passiveInit.runId,
        backendSessionId: "rpc-thread-9",
        updatedAt: setBackendSession.result.updatedAt,
        changed: true,
      });

      const clearedBackendSession = await client.call("runs.clearBackendSession", {
        target: passiveInit.runId,
      });
      assert.deepEqual(clearedBackendSession.result, {
        runId: passiveInit.runId,
        backendSessionId: null,
        updatedAt: clearedBackendSession.result.updatedAt,
        changed: true,
      });

      const scheduled = await client.call("runs.setSchedule", {
        target: init.runId,
        schedule: { at: "2099-04-25T12:00:00.000Z" },
      });
      assert.equal(scheduled.run.schedule.runAt, "2099-04-25T12:00:00.000Z");

      const disabledSchedule = await client.call("runs.disableSchedule", {
        target: init.runId,
      });
      assert.equal(disabledSchedule.run.schedule.enabled, false);

      const clearedSchedule = await client.call("runs.clearSchedule", {
        target: init.runId,
      });
      assert.equal(clearedSchedule.run.schedule, null);

      const tasks = await client.call("tasks.list", { target: init.runId });
      assert.equal(tasks.tasks.length, 1);
      assert.equal(tasks.tasks[0].id, "t1");

      const updated = await client.call("tasks.set", {
        target: init.runId,
        taskId: "t1",
        status: "completed",
        notes: "Handled through daemon RPC.",
      });
      assert.equal(updated.task.status, "completed");
      assert.equal(updated.task.notes, "Handled through daemon RPC.");

      const addedTask = await client.call("tasks.add", {
        target: init.runId,
        title: "RPC follow-up",
        body: "queued over RPC",
      });
      assert.equal(addedTask.task.title, "RPC follow-up");

      const editedTask = await client.call("tasks.set", {
        target: init.runId,
        taskId: addedTask.task.id,
        title: "RPC edited follow-up",
        body: "edited over RPC",
      });
      assert.equal(editedTask.task.title, "RPC edited follow-up");
      assert.equal(editedTask.task.body, "edited over RPC");

      const deletedTask = await client.call("tasks.delete", {
        target: init.runId,
        taskId: addedTask.task.id,
      });
      assert.deepEqual(deletedTask.result, {
        runId: init.runId,
        taskId: addedTask.task.id,
        deleted: true,
        updatedAt: deletedTask.result.updatedAt,
      });

      patchManifest(child.workspaceDir, (manifest) => {
        manifest.status = "success";
        manifest.endedAt = "2026-04-20T10:00:00.000Z";
        manifest.exitCode = 0;
        manifest.finalTasks.t1.status = "completed";
        manifest.tasksCompleted = 1;
      });
      const terminalUpdated = await client.call("tasks.set", {
        target: child.runId,
        taskId: "t1",
        status: "pending",
      });
      assert.equal(terminalUpdated.task.status, "pending");
      const terminalDetail = await client.call("runs.get", { target: child.runId });
      assert.equal(terminalDetail.run.status, "success");
      assert.deepEqual(terminalDetail.run.capabilities.taskMutation, {
        canSetStatus: true,
        canEditNotes: true,
        canAdd: true,
        canEditPending: true,
        canDeletePending: true,
      });

      const readied = await client.call("runs.ready", {
        target: init.runId,
      });
      assert.equal(readied.run.status, "ready");
      assert.equal(readied.run.capabilities.canReady, false);
      assert.equal(readied.run.capabilities.canResume, true);

      const readyDetail = await client.call("runs.get", { target: init.runId });
      assert.equal(readyDetail.run.status, "ready");
      assert.equal(readyDetail.run.capabilities.canReady, false);
      assert.equal(readyDetail.run.capabilities.canResume, true);

      const agents = await client.call("agents.list");
      assert.ok(agents.agents.entries.some((entry) => entry.name === "daemon-agent"));
      assert.deepEqual(agents.agents.warnings, []);

      const assignment = await client.call("assignments.get", {
        target: "daemon-work",
        cwd: dir,
      });
      assert.equal(assignment.assignment.config.name, "daemon-work");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon RPC and HTTP queued resume message endpoints publish shared DTOs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let releaseActiveRun;
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ emitEvent }) {
        markRunRunning(run.workspaceDir);
        emitRunStarted(emitEvent, run.runId, dir);
        await new Promise((resolve) => {
          releaseActiveRun = resolve;
        });
        return { runId: run.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.start", { cliVars: {}, overrides: {} });
      const rpcQueued = await client.call("runs.queueResumeMessage", {
        target: run.runId,
        message: "  queued over rpc  ",
      });
      assert.equal(rpcQueued.run.runId, run.runId);
      assert.equal(rpcQueued.queuedResumeMessage.text, "queued over rpc");
      assert.equal(rpcQueued.run.queuedResumeMessages.length, 1);

      const httpQueued = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/queued-resume-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "queued over http" }),
        },
      );
      assert.equal(httpQueued.status, 200);
      assert.equal(httpQueued.body.run.runId, run.runId);
      assert.equal(httpQueued.body.queuedResumeMessage.text, "queued over http");

      const detail = await client.call("runs.get", { target: run.runId });
      assert.deepEqual(
        detail.run.queuedResumeMessages.map((message) => message.text),
        ["queued over rpc", "queued over http"],
      );
      const summary = (await client.call("runs.list", {})).runs.find(
        (candidate) => candidate.runId === run.runId,
      );
      assert.equal(summary?.queuedResumeMessageCount, 2);

      const rpcRemoved = await client.call("runs.removeQueuedResumeMessage", {
        target: run.runId,
        messageId: rpcQueued.queuedResumeMessage.id,
      });
      assert.equal(rpcRemoved.removedMessageId, rpcQueued.queuedResumeMessage.id);
      assert.deepEqual(
        rpcRemoved.run.queuedResumeMessages.map((message) => message.id),
        [httpQueued.body.queuedResumeMessage.id],
      );

      const httpRemoved = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/queued-resume-messages/${httpQueued.body.queuedResumeMessage.id}`,
        { method: "DELETE" },
      );
      assert.equal(httpRemoved.status, 200);
      assert.equal(httpRemoved.body.removedMessageId, httpQueued.body.queuedResumeMessage.id);
      assert.deepEqual(httpRemoved.body.run.queuedResumeMessages, []);

      const emptyMessage = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/queued-resume-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: " " }),
        },
      );
      assert.equal(emptyMessage.status, 400);
      assert.equal(emptyMessage.body.error.code, "INVALID_REQUEST");

      const missingRemove = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/queued-resume-messages/missing-qmsg`,
        { method: "DELETE" },
      );
      assert.equal(missingRemove.status, 404);
      assert.equal(missingRemove.body.error.code, "NOT_FOUND");

      markRunSuccessful(run.workspaceDir);
      const terminalQueue = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/queued-resume-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "too late" }),
        },
      );
      assert.equal(terminalQueue.status, 409);
      assert.equal(terminalQueue.body.error.code, "CONFLICT");
      await assert.rejects(
        () =>
          client.call("runs.queueResumeMessage", {
            target: run.runId,
            message: "too late",
          }),
        (error) => {
          assert.ok(error instanceof DaemonRpcError);
          assert.equal(error.code, RPC_ERROR_COMMAND);
          assert.match(error.message, /queue is only available while the run is live/);
          return true;
        },
      );
    } finally {
      releaseActiveRun?.();
      await client.close();
      await server.close();
    }
  });
});

test("connected cli sends caller cwd scope while daemon and http defaults remain global", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const first = await initRun(dir);
  const otherCwd = join(dir, "other-cwd");
  mkdirSync(otherCwd, { recursive: true });
  const second = await initRun(dir);

  patchManifest(first.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T10:00:00.000Z";
  });
  patchManifest(second.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T11:00:00.000Z";
    manifest.cwd = otherCwd;
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  try {
    const defaultHttp = await httpJson(httpBaseUrl, "/api/runs");
    assert.equal(defaultHttp.status, 200);
    assert.deepEqual(
      defaultHttp.body.runs.map((run) => run.runId),
      [second.runId, first.runId],
    );

    const scopedHttp = await httpJson(httpBaseUrl, `/api/runs?cwd=${encodeURIComponent(otherCwd)}`);
    assert.equal(scopedHttp.status, 200);
    assert.deepEqual(
      scopedHttp.body.runs.map((run) => run.runId),
      [second.runId],
    );

    const cliDefault = runCli(["list", "runs", "--connect", listenUrl], { cwd: dir });
    assert.equal(
      cliDefault.trim(),
      `${first.runId} [initialized] name=<unnamed> 0/1 repo=unknown agent=daemon-agent assignment=daemon-work cwd=${dir}`,
    );
    assert.doesNotMatch(cliDefault, new RegExp(second.runId));

    const cliScoped = runCli(["list", "runs", "--connect", listenUrl], { cwd: otherCwd });
    assert.match(cliScoped, new RegExp(`^${second.runId} \\[initialized\\]`, "m"));
    assert.doesNotMatch(cliScoped, new RegExp(first.runId));

    const cliGlobal = runCli(["list", "runs", "--global", "--connect", listenUrl], {
      cwd: dir,
    });
    assert.match(cliGlobal, new RegExp(`^${second.runId} \\[initialized\\]`, "m"));
    assert.match(cliGlobal, new RegExp(`^${first.runId} \\[initialized\\]`, "m"));

    const statusText = runCli(["run", "status", second.runId, "--connect", listenUrl], {
      cwd: dir,
    });
    assert.match(statusText, new RegExp(`── run ${second.runId} ──`));
  } finally {
    await daemon.stop();
  }
});

test("daemon HTTP routes mirror shared run/task DTOs and error envelopes", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAgent(dir, "passive-daemon-agent", PASSIVE_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const child = await initRun(dir, "daemon-agent", { parentRunId: init.runId });
  const passiveInit = await initRun(dir, "passive-daemon-agent");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "api.md"), "# API\n\nDaemon workspace text.\n");

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const daemon = await httpJson(httpBaseUrl, "/api/daemon");
      assert.equal(daemon.status, 200);
      assert.equal(daemon.body.daemon.listenUrl, listenUrl);
      assert.equal(daemon.body.daemon.pid, process.pid);
      assert.match(
        daemon.body.daemon.daemonInstanceId,
        new RegExp(`^daemon-${daemon.body.daemon.pid}-[0-9a-z]+$`),
      );

      const runs = await httpJson(httpBaseUrl, "/api/runs");
      assert.equal(runs.status, 200);
      const initSummary = runs.body.runs.find((run) => run.runId === init.runId);
      assert.equal(initSummary?.runId, init.runId);
      assert.equal(initSummary?.status, "initialized");
      assert.equal(initSummary?.effectiveStatus, "initialized");
      assert.equal(initSummary?.capabilities.canReady, true);
      assert.equal(initSummary?.capabilities.canResume, false);
      assert.deepEqual(initSummary?.dependencyState, {
        ready: true,
        total: 0,
        satisfied: 0,
        unsatisfied: 0,
      });
      assert.deepEqual(initSummary?.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(initSummary?.capabilities.canAbort, false);
      assert.equal(initSummary?.capabilities.abortReason, "not_active_in_daemon");
      assert.equal(
        runs.body.runs.find((run) => run.runId === child.runId)?.parentRunId,
        init.runId,
      );
      assert.equal(runs.body.runs.find((run) => run.runId === init.runId)?.runGroupId, init.runId);
      assert.equal(runs.body.runs.find((run) => run.runId === child.runId)?.runGroupId, init.runId);

      const detail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.assignment.name, "daemon-work");
      assert.equal("assignmentPath" in detail.body.run, false);
      assert.equal("workspacePath" in detail.body.run.assignment, false);
      assert.equal(detail.body.run.name, null);
      assert.equal(detail.body.run.status, "initialized");
      assert.equal(detail.body.run.effectiveStatus, "initialized");
      assert.equal(detail.body.run.capabilities.canReady, true);
      assert.equal(detail.body.run.capabilities.canResume, false);
      assert.deepEqual(detail.body.run.dependencies, []);
      assert.deepEqual(detail.body.run.dependents, []);
      assert.deepEqual(detail.body.run.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(detail.body.run.capabilities.canAbort, false);
      assert.equal(detail.body.run.capabilities.abortReason, "not_active_in_daemon");

      const scheduled = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at: "2099-04-25T12:00:00.000Z" }),
      });
      assert.equal(scheduled.status, 200);
      assert.equal(scheduled.body.run.schedule.runAt, "2099-04-25T12:00:00.000Z");

      const disabledSchedule = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/schedule/disable`,
        { method: "POST" },
      );
      assert.equal(disabledSchedule.status, 200);
      assert.equal(disabledSchedule.body.run.schedule.enabled, false);

      const badSchedule = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at: "2099-04-25T12:00:00.000Z", extra: true }),
      });
      assert.equal(badSchedule.status, 400);
      assert.match(badSchedule.body.error.message, /request body\.schedule\.extra/);

      const clearedSchedule = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/schedule`, {
        method: "DELETE",
      });
      assert.equal(clearedSchedule.status, 200);
      assert.equal(clearedSchedule.body.run.schedule, null);

      const childDetail = await httpJson(httpBaseUrl, `/api/runs/${child.runId}`);
      assert.equal(childDetail.status, 200);
      assert.equal(childDetail.body.run.parentRunId, init.runId);

      const dependency = await initRun(dir);
      const addedDependency = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "run", runId: dependency.runId }),
      });
      assert.equal(addedDependency.status, 200);
      assert.deepEqual(addedDependency.body.result, {
        runId: init.runId,
        dependencies: [{ type: "run", runId: dependency.runId }],
        updatedAt: addedDependency.body.result.updatedAt,
        changed: true,
      });

      const removedDependency = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "run", runId: dependency.runId }),
        },
      );
      assert.equal(removedDependency.status, 200);
      assert.deepEqual(removedDependency.body.result, {
        runId: init.runId,
        dependencies: [],
        updatedAt: removedDependency.body.result.updatedAt,
        changed: true,
      });

      const clearedDependencies = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies/clear`,
        {
          method: "POST",
        },
      );
      assert.equal(clearedDependencies.status, 200);
      assert.deepEqual(clearedDependencies.body.result, {
        runId: init.runId,
        dependencies: [],
        updatedAt: removedDependency.body.result.updatedAt,
        changed: false,
      });

      const renamed = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "HTTP renamed run" }),
      });
      assert.equal(renamed.status, 200);
      assert.deepEqual(renamed.body.result, {
        runId: init.runId,
        name: "HTTP renamed run",
        updatedAt: renamed.body.result.updatedAt,
        changed: true,
      });

      const renamedDetail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(renamedDetail.status, 200);
      assert.equal(renamedDetail.body.run.name, "HTTP renamed run");

      const cleared = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: null }),
      });
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.body.result, {
        runId: init.runId,
        name: null,
        updatedAt: cleared.body.result.updatedAt,
        changed: true,
      });

      const noted = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/note`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "HTTP note for the drawer tab" }),
      });
      assert.equal(noted.status, 200);
      assert.deepEqual(noted.body.result, {
        runId: init.runId,
        note: "HTTP note for the drawer tab",
        updatedAt: noted.body.result.updatedAt,
        changed: true,
      });

      const pinned = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/pinned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      assert.equal(pinned.status, 200);
      assert.deepEqual(pinned.body.result, {
        runId: init.runId,
        pinned: true,
        updatedAt: pinned.body.result.updatedAt,
        changed: true,
      });

      const notedDetail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(notedDetail.status, 200);
      assert.equal(notedDetail.body.run.note, "HTTP note for the drawer tab");
      assert.equal(notedDetail.body.run.pinned, true);
      const notedSummary = await httpJson(httpBaseUrl, "/api/runs");
      assert.equal(
        notedSummary.body.runs.find((run) => run.runId === init.runId)?.notePresent,
        true,
      );
      assert.equal(notedSummary.body.runs.find((run) => run.runId === init.runId)?.pinned, true);

      const setBackendSession = await httpJson(
        httpBaseUrl,
        `/api/runs/${passiveInit.runId}/backend-session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backendSessionId: "http-thread-5" }),
        },
      );
      assert.equal(setBackendSession.status, 200);
      assert.deepEqual(setBackendSession.body.result, {
        runId: passiveInit.runId,
        backendSessionId: "http-thread-5",
        updatedAt: setBackendSession.body.result.updatedAt,
        changed: true,
      });

      const clearedBackendSession = await httpJson(
        httpBaseUrl,
        `/api/runs/${passiveInit.runId}/backend-session/clear`,
        {
          method: "POST",
        },
      );
      assert.equal(clearedBackendSession.status, 200);
      assert.deepEqual(clearedBackendSession.body.result, {
        runId: passiveInit.runId,
        backendSessionId: null,
        updatedAt: clearedBackendSession.body.result.updatedAt,
        changed: true,
      });

      const invalidBackendSessionRequest = await httpJson(
        httpBaseUrl,
        `/api/runs/${passiveInit.runId}/backend-session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backendSessionId: "   " }),
        },
      );
      assert.equal(invalidBackendSessionRequest.status, 400);
      assert.equal(invalidBackendSessionRequest.body.error.code, "INVALID_REQUEST");

      const tasks = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks`);
      assert.equal(tasks.status, 200);
      assert.equal(tasks.body.tasks[0].id, "t1");

      const updated = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks/t1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed", notes: "Handled over HTTP." }),
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.task.status, "completed");
      assert.equal(updated.body.task.notes, "Handled over HTTP.");

      const appended = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/tasks/t1/append-notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Second line." }),
        },
      );
      assert.equal(appended.status, 200);
      assert.match(appended.body.task.notes, /Handled over HTTP\.\nSecond line\./);

      const added = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Follow-up task", body: "via HTTP" }),
      });
      assert.equal(added.status, 200);
      assert.equal(added.body.task.title, "Follow-up task");

      const editedTask = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/tasks/${added.body.task.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Edited follow-up", body: "edited via HTTP" }),
        },
      );
      assert.equal(editedTask.status, 200);
      assert.equal(editedTask.body.task.title, "Edited follow-up");
      assert.equal(editedTask.body.task.body, "edited via HTTP");

      const deletedTask = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/tasks/${added.body.task.id}`,
        { method: "DELETE" },
      );
      assert.equal(deletedTask.status, 200);
      assert.deepEqual(deletedTask.body.result, {
        runId: init.runId,
        taskId: added.body.task.id,
        deleted: true,
        updatedAt: deletedTask.body.result.updatedAt,
      });

      const workspaceRoot = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/workspace/files`);
      assert.equal(workspaceRoot.status, 200);
      assert.equal(workspaceRoot.body.directory.runId, init.runId);

      const workspaceDocs = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/files?path=docs`,
      );
      assert.equal(workspaceDocs.status, 200);
      assert.deepEqual(
        workspaceDocs.body.directory.entries.map((entry) => entry.path),
        ["docs/api.md"],
      );

      const workspaceSearch = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/search?q=api&limit=5`,
      );
      assert.equal(workspaceSearch.status, 200);
      assert.equal(workspaceSearch.body.search.maxResults, 5);
      assert.deepEqual(
        workspaceSearch.body.search.matches.map((entry) => entry.path),
        ["docs/api.md"],
      );

      const workspaceFile = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/file?path=docs%2Fapi.md`,
      );
      assert.equal(workspaceFile.status, 200);
      assert.equal(workspaceFile.body.file.mediaType, "text/markdown");
      assert.equal(workspaceFile.body.file.text, "# API\n\nDaemon workspace text.\n");

      const workspaceTraversal = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/file?path=..%2Fsecret.txt`,
      );
      assert.equal(workspaceTraversal.status, 400);
      assert.equal(workspaceTraversal.body.error.code, "INVALID_REQUEST");

      const readied = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/ready`, {
        method: "POST",
      });
      assert.equal(readied.status, 200);
      assert.equal(readied.body.run.status, "ready");
      assert.equal(readied.body.run.capabilities.canReady, false);
      assert.equal(readied.body.run.capabilities.canResume, true);

      const notFound = await httpJson(httpBaseUrl, "/api/runs/missing-run");
      assert.equal(notFound.status, 404);
      assert.equal(notFound.body.error.code, "NOT_FOUND");

      const badQuery = await httpJson(httpBaseUrl, "/api/runs?includeArchived=maybe");
      assert.equal(badQuery.status, 400);
      assert.equal(badQuery.body.error.code, "INVALID_REQUEST");

      const invalidStatus = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks/t1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "bogus" }),
      });
      assert.equal(invalidStatus.status, 400);
      assert.equal(invalidStatus.body.error.code, "INVALID_REQUEST");

      const invalidDependencyRequest = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(invalidDependencyRequest.status, 400);
      assert.equal(invalidDependencyRequest.body.error.code, "INVALID_REQUEST");

      const malformed = await fetch(new URL(`/api/runs/${init.runId}/tasks/t1`, httpBaseUrl), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      const malformedBody = await malformed.json();
      assert.equal(malformed.status, 400);
      assert.equal(malformedBody.error.code, "INVALID_REQUEST");
    } finally {
      await server.close();
    }
  });
});

test("daemon attachment HTTP routes upload, list, download, remove, and reject max-count overflow", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const uploaded = await fetch(new URL(`/api/runs/${init.runId}/attachments`, httpBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-agent-runner-attachment-name": "evidence.txt",
        },
        body: Buffer.from("evidence payload\n"),
      });
      const uploadedBody = await uploaded.json();
      assert.equal(uploaded.status, 200);
      assert.equal(uploadedBody.attachment.name, "evidence.txt");
      assert.equal(uploadedBody.attachment.mimeType, "text/plain");

      const attachmentId = uploadedBody.attachment.id;
      const listed = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/attachments`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.attachments.length, 1);
      assert.equal(listed.body.attachments[0].id, attachmentId);
      assert.equal(listed.body.attachments[0].ownerRunId, init.runId);

      const content = await fetch(
        new URL(`/api/runs/${init.runId}/attachments/${attachmentId}/content`, httpBaseUrl),
      );
      assert.equal(content.status, 200);
      assert.equal(await content.text(), "evidence payload\n");
      assert.equal(content.headers.get("x-agent-runner-attachment-id"), attachmentId);
      assert.equal(content.headers.get("x-agent-runner-sha256"), uploadedBody.attachment.sha256);
      assert.match(
        content.headers.get("content-disposition") ?? "",
        /attachment; filename\*=UTF-8''evidence\.txt/,
      );

      const removed = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/attachments/${attachmentId}`,
        {
          method: "DELETE",
        },
      );
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body.result, {
        runId: init.runId,
        attachmentId,
        changed: true,
      });

      patchManifest(init.workspaceDir, (manifest) => {
        manifest.attachments = Array.from({ length: 100 }, (_, index) => ({
          id: `att-${index}`,
          name: `existing-${index}.txt`,
          mimeType: "text/plain",
          size: 1,
          sha256: `${index}`.padStart(64, "0"),
          addedAt: "2026-04-14T00:00:00.000Z",
          relativePath: `attachments/att-${index}/existing-${index}.txt`,
        }));
      });

      const rejected = await fetch(new URL(`/api/runs/${init.runId}/attachments`, httpBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-agent-runner-attachment-name": "overflow.txt",
        },
        body: Buffer.from("x"),
      });
      const rejectedBody = await rejected.json();
      assert.equal(rejected.status, 422);
      assert.equal(rejectedBody.error.code, "INVALID_COMMAND");
      assert.match(rejectedBody.error.message, /already has 100 attachments/);
    } finally {
      await server.close();
    }
  });
});

test("daemon run-list group filtering supports HTTP and RPC and rejects invalid targets", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const root = await initRun(dir);
  const target = await initRun(dir, "daemon-agent", { parentRunId: root.runId });
  const peer = await initRun(dir, "daemon-agent", { parentRunId: root.runId });
  const child = await initRun(dir, "daemon-agent", { parentRunId: target.runId });
  const different = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const client = await DaemonClient.connect(listenUrl);
    try {
      const httpGroup = await httpJson(httpBaseUrl, `/api/runs?runGroupId=${root.runId}`);
      assert.equal(httpGroup.status, 200);
      assert.deepEqual(
        new Set(httpGroup.body.runs.map((run) => run.runId)),
        new Set([root.runId, target.runId, peer.runId, child.runId]),
      );
      assert.equal(
        httpGroup.body.runs.some((run) => run.runId === different.runId),
        false,
      );

      const rpcGroup = await client.call("runs.list", {
        scope: { kind: "group", runGroupId: root.runId },
      });
      assert.deepEqual(
        new Set(rpcGroup.runs.map((run) => run.runId)),
        new Set([root.runId, target.runId, peer.runId, child.runId]),
      );

      const conflicting = await httpJson(
        httpBaseUrl,
        `/api/runs?runGroupId=${root.runId}&repo=${encodeURIComponent("daemon-control-plane")}`,
      );
      assert.equal(conflicting.status, 400);
      assert.equal(conflicting.body.error.code, "INVALID_REQUEST");
      assert.match(
        conflicting.body.error.message,
        /runs\.list accepts only one of cwd, repo, global=true, or runGroupId/,
      );

      const malformed = await httpJson(httpBaseUrl, "/api/runs?runGroupId=../bad");
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.error.code, "INVALID_REQUEST");
      assert.equal(
        malformed.body.error.message,
        "runGroupId cannot contain control characters, /, or \\",
      );

      const empty = await httpJson(httpBaseUrl, "/api/runs?runGroupId=");
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error.code, "INVALID_REQUEST");
      assert.match(empty.body.error.message, /runGroupId cannot be empty/);

      const missing = await httpJson(httpBaseUrl, "/api/runs?runGroupId=missing-run");
      assert.equal(missing.status, 200);
      assert.deepEqual(missing.body.runs, []);

      patchManifest(target.workspaceDir, (manifest) => {
        manifest.parentRunId = "missing-parent";
      });

      const unresolved = await httpJson(httpBaseUrl, `/api/runs?runGroupId=${target.runId}`);
      assert.equal(unresolved.status, 200);
      assert.deepEqual(unresolved.body.runs, []);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon attachment HTTP routes default to group scope and reject invalid scope query values", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const root = await initRun(dir);
  const target = await initRun(dir, "daemon-agent", { parentRunId: root.runId });
  const peer = await initRun(dir, "daemon-agent", { parentRunId: root.runId });
  const child = await initRun(dir, "daemon-agent", { parentRunId: target.runId });
  const different = await initRun(dir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      for (const [runId, name] of [
        [root.runId, "root.txt"],
        [target.runId, "target.txt"],
        [peer.runId, "peer.txt"],
        [child.runId, "child.txt"],
        [different.runId, "different.txt"],
      ]) {
        const response = await fetch(new URL(`/api/runs/${runId}/attachments`, httpBaseUrl), {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "x-agent-runner-attachment-name": name,
          },
          body: Buffer.from(`${name}\n`),
        });
        assert.equal(response.status, 200);
      }

      const scoped = await httpJson(httpBaseUrl, `/api/runs/${target.runId}/attachments`);
      assert.equal(scoped.status, 200);
      assert.deepEqual(
        new Set(scoped.body.attachments.map((attachment) => attachment.ownerRunId)),
        new Set([root.runId, target.runId, peer.runId, child.runId]),
      );
      assert.equal(
        scoped.body.attachments.some((attachment) => attachment.ownerRunId === different.runId),
        false,
      );

      const unscoped = await httpJson(
        httpBaseUrl,
        `/api/runs/${target.runId}/attachments?scope=run`,
      );
      assert.equal(unscoped.status, 200);
      assert.deepEqual(
        unscoped.body.attachments.map((attachment) => attachment.ownerRunId),
        [target.runId],
      );

      const invalid = await httpJson(
        httpBaseUrl,
        `/api/runs/${target.runId}/attachments?scope=mesh`,
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_REQUEST");
      assert.match(invalid.body.error.message, /scope must be "run" or "group"/);
    } finally {
      await server.close();
    }
  });
});

test("connected CLI attachments use WebSocket streams for add, list, download, and remove", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const sourcePath = join(dir, "evidence.txt");
  const downloadPath = join(dir, "downloaded.txt");
  const existingPath = join(dir, "existing.txt");
  const oversizedPath = join(dir, "oversized.bin");
  writeFileSync(sourcePath, "connected websocket evidence\n");
  writeFileSync(existingPath, "do not overwrite\n");
  writeFileSync(oversizedPath, "");
  truncateSync(oversizedPath, 25 * 1024 * 1024 + 1);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const added = JSON.parse(
      runCli(
        [
          "attachment",
          "add",
          init.runId,
          sourcePath,
          "--name",
          "remote-evidence.txt",
          "--mime-type",
          "text/plain",
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir },
      ),
    );
    assert.deepEqual(Object.keys(added).sort(), [
      "addedAt",
      "id",
      "mimeType",
      "name",
      "relativePath",
      "sha256",
      "size",
    ]);
    assert.equal(added.name, "remote-evidence.txt");
    assert.equal(added.mimeType, "text/plain");

    const listed = JSON.parse(
      runCli(
        [
          "attachment",
          "list",
          init.runId,
          "--scope",
          "run",
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir },
      ),
    );
    assert.deepEqual(
      listed.map((entry) => ({ id: entry.id, ownerRunId: entry.ownerRunId })),
      [{ id: added.id, ownerRunId: init.runId }],
    );

    const overwrite = runCliExpectFail(
      ["attachment", "download", init.runId, added.id, existingPath, "--connect", listenUrl],
      { cwd: dir },
    );
    assert.equal(overwrite.status, 3);
    assert.match(overwrite.stderr, /destination file .*existing\.txt already exists/);
    assert.equal(readFileSync(existingPath, "utf8"), "do not overwrite\n");

    const downloaded = JSON.parse(
      runCli(
        [
          "attachment",
          "download",
          init.runId,
          added.id,
          downloadPath,
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir },
      ),
    );
    assert.equal(downloaded.outputPath, downloadPath);
    assert.equal(downloaded.id, added.id);
    assert.equal(readFileSync(downloadPath, "utf8"), "connected websocket evidence\n");

    const oversized = runCliExpectFail(
      ["attachment", "add", init.runId, oversizedPath, "--connect", listenUrl],
      { cwd: dir },
    );
    assert.equal(oversized.status, 3);
    assert.match(oversized.stderr, /25 MiB max|size must be less than or equal/);
    assert.equal(readManifest(init.workspaceDir).attachments.length, 1);

    const removed = JSON.parse(
      runCli(
        [
          "attachment",
          "remove",
          init.runId,
          added.id,
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir },
      ),
    );
    assert.deepEqual(removed, {
      runId: init.runId,
      attachmentId: added.id,
      changed: true,
    });
  } finally {
    await daemon.stop();
  }
});

test("connected CLI attachment commands do not use daemon attachment HTTP helpers", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const sourcePath = join(dir, "no-http-source.txt");
  const downloadPath = join(dir, "no-http-download.txt");
  const failFetchPath = join(dir, "fail-fetch.mjs");
  writeFileSync(sourcePath, "no http helpers\n");
  writeFileSync(
    failFetchPath,
    "globalThis.fetch = async () => { throw new Error('HTTP disabled for connected attachment test'); };",
  );
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  const env = { NODE_OPTIONS: `--import=${failFetchPath}` };
  try {
    const added = JSON.parse(
      runCli(
        [
          "attachment",
          "add",
          init.runId,
          sourcePath,
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir, env },
      ),
    );
    assert.equal(added.name, "no-http-source.txt");
    const listed = JSON.parse(
      runCli(
        ["attachment", "list", init.runId, "--connect", listenUrl, "--output-format", "json"],
        { cwd: dir, env },
      ),
    );
    assert.equal(listed[0].ownerRunId, init.runId);
    const downloaded = JSON.parse(
      runCli(
        [
          "attachment",
          "download",
          init.runId,
          added.id,
          downloadPath,
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir, env },
      ),
    );
    assert.equal(downloaded.outputPath, downloadPath);
    assert.equal(readFileSync(downloadPath, "utf8"), "no http helpers\n");
    const removed = JSON.parse(
      runCli(
        [
          "attachment",
          "remove",
          init.runId,
          added.id,
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir, env },
      ),
    );
    assert.equal(removed.changed, true);
  } finally {
    await daemon.stop();
  }
});

test("daemon attachment streams handle sequential, concurrent, and disconnect cleanup", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const firstSource = join(dir, "first.txt");
  const secondSource = join(dir, "second.txt");
  const firstDownload = join(dir, "first-download.txt");
  const secondDownload = join(dir, "second-download.txt");
  writeFileSync(firstSource, "first stream\n");
  writeFileSync(secondSource, "second stream\n");
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const client = await DaemonClient.connect(listenUrl);
    try {
      const first = await client.addAttachment(init.runId, {
        sourcePath: firstSource,
        name: "first.txt",
      });
      const second = await client.addAttachment(init.runId, {
        sourcePath: secondSource,
        name: "second.txt",
      });
      assert.deepEqual(
        (await client.listAttachments(init.runId, { scope: "run" })).map((entry) => entry.id),
        [first.id, second.id],
      );

      const [firstResult, secondResult] = await Promise.all([
        client.downloadAttachment(init.runId, first.id, firstDownload),
        client.downloadAttachment(init.runId, second.id, secondDownload),
      ]);
      assert.equal(firstResult.id, first.id);
      assert.equal(secondResult.id, second.id);
      assert.equal(readFileSync(firstDownload, "utf8"), "first stream\n");
      assert.equal(readFileSync(secondDownload, "utf8"), "second stream\n");

      for (const size of [2 * 1024 * 1024, 5 * 1024 * 1024]) {
        const sourcePath = join(dir, `large-${size}.bin`);
        const downloadPath = join(dir, `large-${size}-download.bin`);
        const sourceBytes = Buffer.alloc(size, size % 251);
        writeFileSync(sourcePath, sourceBytes);
        const attachment = await client.addAttachment(init.runId, {
          sourcePath,
          name: `large-${size}.bin`,
        });
        const downloadResult = await client.downloadAttachment(
          init.runId,
          attachment.id,
          downloadPath,
        );
        assert.equal(downloadResult.id, attachment.id);
        assert.deepEqual(readFileSync(downloadPath), sourceBytes);
        await client.removeAttachment(init.runId, attachment.id);
      }

      await client.removeAttachment(init.runId, first.id);
      await client.removeAttachment(init.runId, second.id);
      assert.deepEqual(await client.listAttachments(init.runId, { scope: "run" }), []);

      const raw = await openRawWebSocket(listenUrl);
      raw.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "open-disconnect",
          method: "attachments.upload.open",
          params: { runId: init.runId, name: "disconnect.txt", size: 11 },
        }),
      );
      const opened = await nextRawMessage(raw);
      raw.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "stream.data",
          params: {
            streamId: opened.result.streamId,
            seq: 0,
            data: Buffer.from("partial").toString("base64"),
          },
        }),
      );
      raw.terminate();
      await sleep(50);
      assert.deepEqual(readManifest(init.workspaceDir).attachments, []);

      const rawFinished = await openRawWebSocket(listenUrl);
      rawFinished.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "open-finished-disconnect",
          method: "attachments.upload.open",
          params: { runId: init.runId, name: "finished-disconnect.txt", size: 8 },
        }),
      );
      const finishedOpened = await nextRawMessage(rawFinished);
      rawFinished.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "stream.data",
          params: {
            streamId: finishedOpened.result.streamId,
            seq: 0,
            data: Buffer.from("complete").toString("base64"),
          },
        }),
      );
      rawFinished.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "stream.end",
          params: { streamId: finishedOpened.result.streamId, seq: 1 },
        }),
      );
      rawFinished.terminate();
      await sleep(50);
      assert.deepEqual(readManifest(init.workspaceDir).attachments, []);

      const downloadCancelAttachment = await client.addAttachment(init.runId, {
        sourcePath: firstSource,
        name: "download-cancel.txt",
      });
      const downloadRaw = await openRawWebSocket(listenUrl);
      downloadRaw.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "download-disconnect",
          method: "attachments.download",
          params: { runId: init.runId, attachmentId: downloadCancelAttachment.id },
        }),
      );
      const downloadOpened = await nextRawMessage(downloadRaw);
      assert.equal(downloadOpened.result.attachment.id, downloadCancelAttachment.id);
      const firstDownloadFrame = await nextRawMessage(downloadRaw);
      assert.equal(firstDownloadFrame.method, "stream.data");
      assert.equal(firstDownloadFrame.params.streamId, downloadOpened.result.streamId);
      downloadRaw.terminate();
      await sleep(50);
      assert.deepEqual(
        (await client.listAttachments(init.runId, { scope: "run" })).map((entry) => entry.id),
        [downloadCancelAttachment.id],
      );
      await client.removeAttachment(init.runId, downloadCancelAttachment.id);
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  });
});

test("daemon serve exposes app config, keeps /api precedence, and falls back to SPA routes", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    await withSeededFrontendDist(async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const appConfig = await httpJson(httpBaseUrl, "/app-config.json");
        assert.equal(appConfig.status, 200);
        assert.deepEqual(appConfig.body, {
          webBasePath: "/",
        });

        const apiDetail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
        assert.equal(apiDetail.status, 200);
        assert.equal(apiDetail.body.run.runId, init.runId);
        assert.equal(apiDetail.body.run.effectiveStatus, "initialized");

        const spaRoot = await fetch(new URL("/", httpBaseUrl));
        const spaRootBody = await spaRoot.text();
        assert.equal(spaRoot.status, 200);
        assert.match(spaRoot.headers.get("content-type") ?? "", /text\/html/);
        assert.match(spaRootBody, /<div id="root"><\/div>/);

        const deepLink = await fetch(new URL(`/runs/${init.runId}`, httpBaseUrl));
        const deepLinkBody = await deepLink.text();
        assert.equal(deepLink.status, 200);
        assert.match(deepLinkBody, /<div id="root"><\/div>/);

        const assetsDirectory = await fetch(new URL("/assets", httpBaseUrl));
        const assetsDirectoryBody = await assetsDirectory.text();
        assert.equal(assetsDirectory.status, 200);
        assert.match(assetsDirectoryBody, /<div id="root"><\/div>/);

        const daemonAfterAssets = await httpJson(httpBaseUrl, "/api/daemon");
        assert.equal(daemonAfterAssets.status, 200);
        assert.equal(daemonAfterAssets.body.daemon.listenUrl, listenUrl);
      } finally {
        await server.close();
      }
    });
  });
});

test("daemon serve reads packaged web assets from the CLI dist layout", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withSeededFrontendDist(async ({ indexPath }) => {
    const packagedIndex = readFileSync(indexPath, "utf8");
    const server = await serveDaemon(listenUrl);
    try {
      const response = await fetch(new URL("/", httpBaseUrl));
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body, packagedIndex);

      const assetPath = body.match(/\/assets\/[^"]+\.(?:js|css)/)?.[0];
      assert.ok(assetPath, "expected built asset path in served index.html");

      const assetResponse = await fetch(new URL(assetPath, httpBaseUrl));
      const assetBody = await assetResponse.text();
      assert.equal(assetResponse.status, 200);
      assert.ok(assetBody.length > 0);
    } finally {
      await server.close();
    }
  });
});

test("daemon serve exposes web runtime config for a mounted base path", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv({ AGENT_RUNNER_WEB_BASE_PATH: "/agent-runner/" }, async () => {
    await withSeededFrontendDist(async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const appConfig = await httpJson(httpBaseUrl, "/app-config.json");
        assert.equal(appConfig.status, 200);
        assert.deepEqual(appConfig.body, {
          webBasePath: "/agent-runner",
        });

        const response = await fetch(new URL("/", httpBaseUrl));
        const body = await response.text();
        assert.equal(response.status, 200);
        assert.match(body, /window\.__AGENT_RUNNER_WEB_BASE_PATH__="\/agent-runner"/);
        const assetPath = body.match(/\/agent-runner\/assets\/[^"]+\.js/)?.[0];
        assert.ok(assetPath, "expected prefixed built asset path in served index.html");

        const prefixedConfig = await httpJson(httpBaseUrl, "/agent-runner/app-config.json");
        assert.equal(prefixedConfig.status, 200);
        assert.deepEqual(prefixedConfig.body, appConfig.body);

        const falsePrefixConfig = await fetch(
          new URL("/agent-runner-other/app-config.json", httpBaseUrl),
        );
        assert.equal(falsePrefixConfig.status, 404);

        const prefixedAsset = await fetch(new URL(assetPath, httpBaseUrl));
        assert.equal(prefixedAsset.status, 200);

        const prefixedApi = await httpJson(httpBaseUrl, "/agent-runner/api/daemon");
        assert.equal(prefixedApi.status, 200);
        assert.equal(prefixedApi.body.daemon.listenUrl, listenUrl);
      } finally {
        await server.close();
      }
    });
  });
});

test("daemon HTTP rejects oversized JSON request bodies", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const oversizedPayload = JSON.stringify({
        webVars: {
          blob: "x".repeat(1024 * 1024),
        },
        overrides: {},
      });
      const response = await fetch(new URL("/api/runs", httpBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversizedPayload,
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "INVALID_REQUEST");
      assert.match(body.error.message, /request body exceeds/i);
    } finally {
      await server.close();
    }
  });
});

test("daemon HTTP rejects encoded traversal route params without leaking paths", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl);
  try {
    const detailResponse = await httpJson(httpBaseUrl, "/api/runs/..%2F..%2Fetc");
    assert.equal(detailResponse.status, 404);
    assert.equal(detailResponse.body.error.code, "NOT_FOUND");
    assert.equal(detailResponse.body.error.message, "resource not found");

    const taskResponse = await httpJson(httpBaseUrl, "/api/runs/..%2F..%2Fetc/tasks");
    assert.equal(taskResponse.status, 404);
    assert.equal(taskResponse.body.error.code, "NOT_FOUND");
    assert.equal(taskResponse.body.error.message, "resource not found");
  } finally {
    await server.close();
  }
});

test("daemon dependency mutation surfaces reject path-like dependency ids over RPC and HTTP", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl);
  const client = await DaemonClient.connect(listenUrl);

  try {
    await assert.rejects(
      () =>
        client.call("runs.addDependency", {
          target: init.runId,
          dependency: { type: "run", runId: "../other-run" },
        }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.message === "dependency.runId must be a run id, not a path",
    );

    const response = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "run", runId: "../other-run" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.equal(response.body.error.message, "request body.runId must be a run id, not a path");
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon run projections expose explicit abort capability from local ownership", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let daemonInstanceId = "daemon-placeholder";
  const runId = "daemon-owned-run";
  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status: "running",
        effectiveStatus: "running",
        archivedAt: null,
        isLive: true,
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "Daemon-owned run",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 1,
        maxAttemptsPerSession: 1,
        totalSessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 1,
        activeTask: null,
        tasks: [
          {
            id: "t1",
            title: "First",
            body: "",
            status: "pending",
            notes: "",
          },
        ],
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId,
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: false,
          abortReason: "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status: "running",
          effectiveStatus: "running",
          archivedAt: null,
          agentName: "daemon-agent",
          name: "Daemon-owned run",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask: null,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId,
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: false,
            abortReason: "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, abortSignal }) {
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "Daemon-owned run",
        cwd: "/tmp/fake",
        sessionIndex: 0,
      });
      emitEvent({
        type: "attempt_started",
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-13T05:00:01.000Z",
        prompt: "Abort prompt",
      });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                sessionAttemptCount: 1,
                totalAttemptCount: 1,
                maxAttemptsPerSession: 1,
                totalSessionCount: 1,
                tasksCompleted: 0,
                tasksTotal: 1,
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const client = await DaemonClient.connect(listenUrl);
  try {
    daemonInstanceId = (await client.call("daemon.info")).daemonInstanceId;
    const started = await client.call("runs.start", { cliVars: {}, overrides: {} });
    assert.equal(started.runId, runId);

    const list = await client.call("runs.list", {});
    assert.equal(list.runs[0].capabilities.canAbort, true);
    assert.equal("abortReason" in list.runs[0].capabilities, false);
    assert.deepEqual(list.runs[0].execution, {
      hostMode: "daemon",
      controller: {
        kind: "daemon",
        daemonInstanceId,
      },
    });

    const detail = await client.call("runs.get", { target: runId });
    assert.equal(detail.run.capabilities.canAbort, true);
    assert.equal("abortReason" in detail.run.capabilities, false);
    assert.deepEqual(detail.run.execution, {
      hostMode: "daemon",
      controller: {
        kind: "daemon",
        daemonInstanceId,
      },
    });

    await client.call("runs.abort", { target: runId });
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon projects active run detail as live while it owns the run", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-live-detail";
  let status = "initialized";

  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: false,
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "Daemon live detail",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 1,
        maxAttemptsPerSession: 1,
        totalSessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 1,
        activeTask: null,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [
          {
            id: "t1",
            title: "First",
            body: "",
            status: "pending",
            notes: "",
          },
        ],
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: false,
          abortReason: "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status,
          effectiveStatus: status,
          archivedAt: null,
          agentName: "daemon-agent",
          name: "Daemon live detail",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask: null,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: false,
            abortReason: "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, abortSignal }) {
      status = "running";
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "Daemon live detail",
        cwd: process.cwd(),
        sessionIndex: 0,
      });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                sessionAttemptCount: 1,
                totalAttemptCount: 1,
                maxAttemptsPerSession: 1,
                totalSessionCount: 1,
                tasksCompleted: 0,
                tasksTotal: 1,
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webVars: {}, overrides: {} }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, runId);

    const detail = await httpJson(httpBaseUrl, `/api/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.status, "running");
    assert.equal(detail.body.run.isLive, true);
    assert.equal(detail.body.run.capabilities.canAbort, true);
    assert.equal(detail.body.run.capabilities.abortReason, undefined);

    const aborted = await httpJson(httpBaseUrl, `/api/runs/${runId}/abort`, { method: "POST" });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.accepted, true);

    let settled = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await httpJson(httpBaseUrl, `/api/runs/${runId}`);
      assert.equal(response.status, 200);
      if (response.body.run.status === "aborted" && response.body.run.isLive === false) {
        settled = response.body.run;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(settled, "expected the daemon to publish a settled aborted projection");
    assert.equal(settled.capabilities.canAbort, false);
    assert.equal(settled.capabilities.abortReason, "already_terminal");
  } finally {
    await server.close();
  }
});

test("daemon projects startup-cleaned terminal runs as non-abortable", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunRunning(run.workspaceDir);
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.endedAt = null;
    manifest.exitCode = null;
    manifest.execution = {
      hostMode: "daemon",
      controller: { kind: "daemon", daemonInstanceId: "previous-daemon" },
    };
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        const detail = await client.call("runs.get", { target: run.runId });
        assert.equal(detail.run.status, "error");
        assert.equal(detail.run.isLive, false);
        assert.equal(detail.run.capabilities.canAbort, false);
        assert.equal(detail.run.capabilities.abortReason, "already_terminal");
      } finally {
        await client.close();
        await server.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon HTTP projections preserve hook summary and detail fields", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-hook-projection";

  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status: "initialized",
        effectiveStatus: "initialized",
        archivedAt: null,
        isLive: false,
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: null,
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "Daemon hook projection",
        note: null,
        pinned: false,
        backendSessionId: null,
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 60,
        startedAt: "2026-04-20T10:00:00.000Z",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 0,
        maxAttemptsPerSession: 1,
        totalSessionCount: 0,
        tasksCompleted: 0,
        tasksTotal: 1,
        attachments: [],
        resolvedHooks: [
          {
            hookId: "prepare:0:freeze",
            phase: "prepare",
            source: { name: "freeze" },
            resolvedPath: "/tmp/hooks/freeze/hook.ts",
            when: null,
            config: { mode: "json" },
          },
        ],
        hookState: { prepared: true },
        hookAudits: [
          {
            phase: "prepare",
            hookId: "prepare:0:freeze",
            startedAt: "2026-04-20T10:00:00.000Z",
            endedAt: "2026-04-20T10:00:01.000Z",
            outcome: "continue",
            sessionIndex: null,
            attemptNumber: null,
            taskId: null,
            summary: null,
          },
        ],
        dependencies: [],
        dependents: [],
        tasks: [
          {
            id: "t1",
            title: "First",
            body: "",
            status: "pending",
            notes: "",
          },
        ],
        activeTask: null,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: false,
          abortReason: "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status: "initialized",
          effectiveStatus: "initialized",
          archivedAt: null,
          agentName: "daemon-agent",
          name: "Daemon hook projection",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-20T10:00:00.000Z",
          endedAt: null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          hookCount: 1,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask: null,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: false,
            abortReason: "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
  });

  try {
    const list = await httpJson(httpBaseUrl, "/api/runs");
    assert.equal(list.status, 200);
    assert.equal(list.body.runs[0].hookCount, 1);

    const detail = await httpJson(httpBaseUrl, `/api/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.resolvedHooks.length, 1);
    assert.deepEqual(detail.body.run.hookState, { prepared: true });
    assert.equal(detail.body.run.hookAudits[0].outcome, "continue");
  } finally {
    await server.close();
  }
});

test("daemon subscriptions fan out run events and abort active runs", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let status = "running";
  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId: "daemon-live-run",
        repo: "agent-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon test",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: status === "aborted" ? "2026-04-13T05:05:00.000Z" : null,
        exitCode: status === "aborted" ? 130 : null,
        totalAttemptCount: 1,
        maxAttemptsPerSession: 1,
        totalSessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 0,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [],
        activeTask: null,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "already_terminal",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    async startRun({ emitEvent, abortSignal }) {
      const runId = "daemon-live-run";
      const summary = {
        status: "aborted",
        sessionAttemptCount: 1,
        totalAttemptCount: 1,
        maxAttemptsPerSession: 1,
        totalSessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 0,
        tasks: [],
        runId,
      };
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "daemon test",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({
        type: "attempt_started",
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-13T05:00:01.000Z",
        prompt: "Abort prompt",
      });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
            emitEvent({ type: "run_aborted" });
            emitEvent({ type: "run_finished", summary });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const clientA = await DaemonClient.connect(listenUrl);
  const clientB = await DaemonClient.connect(listenUrl);
  const seenA = [];
  const seenB = [];
  try {
    const started = await clientA.call("runs.start", {
      cliVars: {},
      overrides: {},
    });
    assert.equal(started.runId, "daemon-live-run");
    await clientA.subscribe({ channel: "run_timeline", runId: started.runId }, (msg) => {
      if (msg.method === "run.timeline") {
        seenA.push(msg.event.type);
      }
    });
    await clientB.subscribe({ channel: "run_timeline", runId: started.runId }, (msg) => {
      if (msg.method === "run.timeline") {
        seenB.push(msg.event.type);
      }
    });

    await clientB.call("runs.abort", { target: started.runId });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(seenA, ["run_started", "attempt_started", "run_aborted", "run_finished"]);
    assert.deepEqual(seenB, ["run_started", "attempt_started", "run_aborted", "run_finished"]);
  } finally {
    await clientA.close();
    await clientB.close();
    await server.close();
  }
});

test("daemon republishes summary and detail projections when a run retries", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-retrying-run";
  let tasksCompleted = 0;
  let activeTask = { id: "t1", title: "First task" };
  let status = "initialized";

  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon retrying test",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: status === "success" ? "2026-04-13T05:05:00.000Z" : null,
        exitCode: status === "success" ? 0 : null,
        totalAttemptCount: status === "success" ? 2 : 1,
        maxAttemptsPerSession: 2,
        totalSessionCount: 1,
        tasksCompleted,
        tasksTotal: 2,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [],
        activeTask,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "already_terminal",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status,
          effectiveStatus: status,
          archivedAt: null,
          agentName: "daemon-agent",
          name: "daemon retrying test",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: status === "success" ? "2026-04-13T05:05:00.000Z" : null,
          tasksCompleted,
          tasksTotal: 2,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: status === "running",
            abortReason: status === "running" ? undefined : "already_terminal",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent }) {
      status = "running";
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "daemon retrying test",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({
        type: "attempt_started",
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-13T05:00:01.000Z",
        prompt: "Attempt one",
      });
      tasksCompleted = 1;
      activeTask = { id: "t2", title: "Second task" };
      emitEvent({
        type: "retrying",
        incompleteCount: 1,
        invalidStatusCount: 0,
      });
      status = "success";
      tasksCompleted = 2;
      activeTask = null;
      emitEvent({
        type: "run_finished",
        summary: {
          status: "success",
          sessionAttemptCount: 2,
          totalAttemptCount: 2,
          maxAttemptsPerSession: 2,
          totalSessionCount: 1,
          tasksCompleted: 2,
          tasksTotal: 2,
          tasks: [],
          runId,
        },
      });
      return { runId };
    },
  });

  const summaries = await openSse(httpBaseUrl, "/api/events/run-summaries");
  const details = await openSse(httpBaseUrl, `/api/runs/${runId}/events/detail`);
  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webVars: {}, overrides: {} }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, runId);

    const startedSummary = await summaries.next();
    const startedDetail = await details.next();
    const retriedSummary = await summaries.next();
    const retriedDetail = await details.next();

    assert.equal(startedSummary.type, "summary_upsert");
    assert.equal(startedSummary.summary.status, "running");
    assert.equal(startedSummary.summary.tasksCompleted, 0);
    assert.deepEqual(startedSummary.summary.activeTask, { id: "t1", title: "First task" });

    assert.equal(startedDetail.type, "detail_updated");
    assert.equal(startedDetail.detail.status, "running");
    assert.equal(startedDetail.detail.tasksCompleted, 0);
    assert.deepEqual(startedDetail.detail.activeTask, { id: "t1", title: "First task" });

    assert.equal(retriedSummary.type, "summary_upsert");
    assert.equal(retriedSummary.summary.status, "running");
    assert.equal(retriedSummary.summary.tasksCompleted, 1);
    assert.deepEqual(retriedSummary.summary.activeTask, { id: "t2", title: "Second task" });

    assert.equal(retriedDetail.type, "detail_updated");
    assert.equal(retriedDetail.detail.status, "running");
    assert.equal(retriedDetail.detail.tasksCompleted, 1);
    assert.deepEqual(retriedDetail.detail.activeTask, { id: "t2", title: "Second task" });
  } finally {
    await summaries.close();
    await details.close();
    await server.close();
  }
});

test("daemon mutation-driven projection SSE events include dependent summary fanout", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-daemon-agent", PASSIVE_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir, "passive-daemon-agent");
  const dependent = await initRun(dir, "passive-daemon-agent");
  patchManifest(dependent.workspaceDir, (manifest) => {
    manifest.dependencies = [{ type: "run", runId: source.runId }];
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const summaries = await openSse(httpBaseUrl, "/api/events/run-summaries");
    const sourceDetails = await openSse(httpBaseUrl, `/api/runs/${source.runId}/events/detail`);
    try {
      const response = await httpJson(httpBaseUrl, `/api/runs/${source.runId}/tasks/t1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.task.status, "completed");

      const sourceSummary = await summaries.next();
      const sourceDetailEvent = await sourceDetails.next();
      const dependentSummary = await summaries.next();

      assert.equal(sourceSummary.type, "summary_upsert");
      assert.equal(sourceSummary.summary.runId, source.runId);
      assert.equal(sourceSummary.summary.effectiveStatus, "success");

      assert.equal(sourceDetailEvent.type, "detail_updated");
      assert.equal(sourceDetailEvent.detail.runId, source.runId);
      assert.equal(sourceDetailEvent.detail.effectiveStatus, "success");

      assert.equal(dependentSummary.type, "summary_upsert");
      assert.equal(dependentSummary.summary.runId, dependent.runId);
      assert.deepEqual(dependentSummary.summary.dependencyState, {
        ready: true,
        total: 1,
        satisfied: 1,
        unsatisfied: 0,
      });
    } finally {
      await summaries.close();
      await sourceDetails.close();
      await server.close();
    }
  });
});

test("daemon resumes unique cross-bucket short ids through RPC and HTTP", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const rpcRun = await initRun(dir);
  const httpRun = await initRun(dir);
  const rpcWorkspaceDir = moveRunToRepoBucket(dir, rpcRun.workspaceDir, "assistant", {
    cwd: join(dir, "assistant-rpc"),
  });
  const httpWorkspaceDir = moveRunToRepoBucket(dir, httpRun.workspaceDir, "assistant", {
    cwd: join(dir, "assistant-http"),
  });
  markRunReady(rpcWorkspaceDir);
  markRunReady(httpWorkspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const resumeTargets = [];

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent }) {
        resumeTargets.push(target);
        const manifest = readManifest(target);
        markRunRunning(target);
        emitRunStarted(emitEvent, manifest.runId, manifest.cwd);
        return { runId: manifest.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      const rpcResult = await client.call("runs.resume", {
        target: rpcRun.runId,
        overrides: {},
      });
      assert.equal(rpcResult.runId, rpcRun.runId);
      assert.equal(
        (await waitForRunStatus(httpBaseUrl, rpcRun.runId, "running")).runId,
        rpcRun.runId,
      );

      const httpResult = await httpJson(httpBaseUrl, `/api/runs/${httpRun.runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrides: {} }),
      });
      assert.equal(httpResult.status, 200);
      assert.deepEqual(httpResult.body, { runId: httpRun.runId });
      assert.equal(
        (await waitForRunStatus(httpBaseUrl, httpRun.runId, "running")).runId,
        httpRun.runId,
      );

      assert.deepEqual(resumeTargets, [rpcWorkspaceDir, httpWorkspaceDir]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon workspace diff HTTP route returns branch and working-tree diffs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  initGitRepo(dir);
  writeFileSync(join(dir, "branch.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "branch.txt"), "base\nfeature\n");
  git(dir, ["commit", "-am", "feature"]);
  writeFileSync(join(dir, "working.txt"), "working tree\n");
  const init = await initRun(dir);
  moveRunToRepoBucket(dir, init.workspaceDir, "agent-runner", { cwd: dir });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const branch = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/diff?mode=branch&base=main&head=HEAD&comparison=merge-base`,
      );
      assert.equal(branch.status, 200, JSON.stringify(branch.body));
      assert.equal(branch.body.diff.runId, init.runId);
      assert.equal(branch.body.diff.displayRange, "main...HEAD");
      assert.deepEqual(
        branch.body.diff.files.map((file) => [file.path, file.status]),
        [["branch.txt", "modified"]],
      );

      const workingTree = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/diff?mode=working-tree`,
      );
      assert.equal(workingTree.status, 200, JSON.stringify(workingTree.body));
      assert.equal(workingTree.body.diff.displayRange, "Working tree");
      assert.deepEqual(
        workingTree.body.diff.files
          .filter((file) => file.path === "working.txt")
          .map((file) => [file.path, file.status]),
        [["working.txt", "untracked"]],
      );
      assert.match(workingTree.body.diff.patch, /diff --git a\/working\.txt b\/working\.txt/);
    } finally {
      await server.close();
    }
  });
});

test("daemon workspace diff HTTP route rejects invalid query shapes and missing refs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  initGitRepo(dir);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  const init = await initRun(dir);
  moveRunToRepoBucket(dir, init.workspaceDir, "agent-runner", { cwd: dir });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const missingQuery = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/diff?mode=branch&base=main`,
      );
      assert.equal(missingQuery.status, 400, JSON.stringify(missingQuery.body));
      assert.equal(missingQuery.body.error.code, "INVALID_REQUEST");
      assert.match(
        missingQuery.body.error.message,
        /comparison must be one of: merge-base, direct/,
      );

      const irrelevantQuery = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/diff?mode=working-tree&base=main`,
      );
      assert.equal(irrelevantQuery.status, 400);
      assert.equal(irrelevantQuery.body.error.code, "INVALID_REQUEST");
      assert.match(irrelevantQuery.body.error.message, /working-tree diff does not support query/);

      const missingRef = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/diff?mode=branch&base=missing&head=HEAD&comparison=direct`,
      );
      assert.equal(missingRef.status, 422);
      assert.equal(missingRef.body.error.code, "INVALID_COMMAND");
      assert.match(missingRef.body.error.message, /missing git base ref "missing"/);

      const optionLikeRef = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/workspace/diff?mode=branch&base=--help&head=HEAD&comparison=direct`,
      );
      assert.equal(optionLikeRef.status, 400);
      assert.equal(optionLikeRef.body.error.code, "INVALID_REQUEST");
      assert.match(optionLikeRef.body.error.message, /base cannot start with "-"/);
    } finally {
      await server.close();
    }
  });
});

test("daemon workspace APIs resolve unique cross-bucket short ids", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  const workspaceCwd = join(dir, "assistant-cwd");
  mkdirSync(join(workspaceCwd, "docs"), { recursive: true });
  writeFileSync(join(workspaceCwd, "docs", "api.md"), "# API\n\nCross-bucket workspace text.\n");
  initGitRepo(workspaceCwd);
  git(workspaceCwd, ["add", "."]);
  git(workspaceCwd, ["commit", "-m", "base"]);
  writeFileSync(
    join(workspaceCwd, "docs", "api.md"),
    "# API\n\nCross-bucket workspace text.\nUpdated through short id.\n",
  );
  moveRunToRepoBucket(dir, run.workspaceDir, "assistant", { cwd: workspaceCwd });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const detail = await httpJson(httpBaseUrl, `/api/runs/${run.runId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.runId, run.runId);

      const workspaceRoot = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/workspace/files?path=`,
      );
      assert.equal(workspaceRoot.status, 200);
      assert.equal(workspaceRoot.body.directory.runId, run.runId);
      assert.equal(workspaceRoot.body.directory.cwd, workspaceCwd);
      assert.deepEqual(
        workspaceRoot.body.directory.entries.map((entry) => entry.path),
        [".git", "docs"],
      );

      const workspaceSearch = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/workspace/search?q=api&limit=5`,
      );
      assert.equal(workspaceSearch.status, 200);
      assert.deepEqual(
        workspaceSearch.body.search.matches.map((entry) => entry.path),
        ["docs/api.md"],
      );

      const workspaceFile = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/workspace/file?path=docs%2Fapi.md`,
      );
      assert.equal(workspaceFile.status, 200);
      assert.equal(
        workspaceFile.body.file.text,
        "# API\n\nCross-bucket workspace text.\nUpdated through short id.\n",
      );

      const workspaceDiff = await httpJson(
        httpBaseUrl,
        `/api/runs/${run.runId}/workspace/diff?mode=working-tree`,
      );
      assert.equal(workspaceDiff.status, 200, JSON.stringify(workspaceDiff.body));
      assert.equal(workspaceDiff.body.diff.cwd, workspaceCwd);
      assert.deepEqual(
        workspaceDiff.body.diff.files.map((entry) => [entry.path, entry.status]),
        [["docs/api.md", "modified"]],
      );
    } finally {
      await server.close();
    }
  });
});

test("daemon rejects ambiguous cross-bucket short ids through RPC and HTTP", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const first = await initRun(dir);
  const duplicate = await initRun(dir);
  const firstWorkspaceDir = moveRunToRepoBucket(dir, first.workspaceDir, "assistant");
  const duplicateWorkspaceDir = moveRunToRepoBucket(dir, duplicate.workspaceDir, "other-repo", {
    runId: first.runId,
  });
  markRunReady(firstWorkspaceDir);
  markRunReady(duplicateWorkspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const ambiguityMessage = `run id "${first.runId}" is ambiguous across repo buckets; use a workspace path instead`;
  const originalConsoleError = console.error;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    console.error = () => undefined;
    const server = await serveDaemon(listenUrl, {
      async resumeRun() {
        throw new Error("ambiguous run id should not reach app.resumeRun");
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await assert.rejects(
        () => client.call("runs.resume", { target: first.runId, overrides: {} }),
        (err) =>
          err instanceof DaemonRpcError &&
          err.code === RPC_ERROR_COMMAND &&
          err.message === ambiguityMessage,
      );

      const httpResult = await httpJson(httpBaseUrl, `/api/runs/${first.runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ overrides: {} }),
      });
      assert.equal(httpResult.status, 409);
      assert.equal(httpResult.body.error.code, "CONFLICT");
      assert.equal(httpResult.body.error.message, ambiguityMessage);

      for (const path of [
        `/api/runs/${first.runId}/workspace/files`,
        `/api/runs/${first.runId}/workspace/search?q=api`,
        `/api/runs/${first.runId}/workspace/file?path=README.md`,
      ]) {
        const workspaceResult = await httpJson(httpBaseUrl, path);
        assert.equal(workspaceResult.status, 409);
        assert.equal(workspaceResult.body.error.code, "CONFLICT");
        assert.equal(workspaceResult.body.error.message, ambiguityMessage);
      }
    } finally {
      console.error = originalConsoleError;
      await client.close();
      await server.close();
    }
  });
});

test("daemon auto-starts ready dependency runs immediately when dependencies are already satisfied", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const dependent = await initRun(dir);
  markRunSuccessful(source.workspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let autoStartCalls = 0;
  let resolveAutoStarted;
  const autoStarted = new Promise((resolve) => {
    resolveAutoStarted = resolve;
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent }) {
        autoStartCalls += 1;
        assert.equal(target, dependent.workspaceDir);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        resolveAutoStarted();
        return { runId: dependent.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.addDependency", {
        target: dependent.runId,
        dependency: { type: "run", runId: source.runId },
      });

      const readied = await client.call("runs.ready", { target: dependent.runId });
      assert.equal(readied.run.status, "ready");
      await autoStarted;
      const running = await waitForRunStatus(httpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
      assert.equal(autoStartCalls, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon auto-starts ready group dependency runs when a member leaves the blocking group", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const movingMember = await initRun(dir);
  const dependent = await initRun(dir);
  markRunSuccessful(source.workspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const resumeTargets = [];

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent }) {
        resumeTargets.push(target);
        assert.equal(target, dependent.workspaceDir);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        return { runId: dependent.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.setGroup", { target: source.runId, runGroupId: "group-a" });
      await client.call("runs.setGroup", { target: movingMember.runId, runGroupId: "group-a" });
      await client.call("runs.addDependency", {
        target: dependent.runId,
        dependency: { type: "group", groupId: "group-a" },
      });

      const dependentReady = await client.call("runs.ready", { target: dependent.runId });
      assert.equal(dependentReady.run.status, "ready");
      assert.deepEqual(resumeTargets, []);

      await client.call("runs.setGroup", { target: movingMember.runId, runGroupId: "group-b" });
      const running = await waitForRunStatus(httpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
      assert.deepEqual(resumeTargets, [dependent.workspaceDir]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon auto-starts ready dependency runs after the final dependency succeeds", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const dependent = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const resumeTargets = [];

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent }) {
        resumeTargets.push(target);
        if (target === source.workspaceDir) {
          markRunRunning(source.workspaceDir);
          emitRunStarted(emitEvent, source.runId, dir);
          markRunSuccessful(source.workspaceDir);
          emitRunFinished(emitEvent, source.runId);
          return { runId: source.runId };
        }

        assert.equal(target, dependent.workspaceDir);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        return { runId: dependent.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.addDependency", {
        target: dependent.runId,
        dependency: { type: "run", runId: source.runId },
      });

      await client.call("runs.ready", { target: source.runId });
      const dependentReady = await client.call("runs.ready", { target: dependent.runId });
      assert.equal(dependentReady.run.status, "ready");
      assert.deepEqual(resumeTargets, []);

      await client.call("runs.resume", { target: source.runId, overrides: {} });
      const running = await waitForRunStatus(httpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
      assert.deepEqual(resumeTargets, [source.workspaceDir, dependent.workspaceDir]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon drains queued resume messages through the real runAgent resume path", async () => {
  const dir = tempDir();
  writeBackend(
    dir,
    "queued-test",
    `export default {
      id: "queued-test",
      async invoke(ctx) {
        const state = globalThis.__queuedResumeBackendState;
        if (!state) {
          throw new Error("missing queued resume backend state");
        }
        state.invocations.push({
          prompt: ctx.prompt,
          resumeSessionId: ctx.resumeSessionId ?? null,
        });
        const release = state.releases.shift();
        if (release) {
          await release;
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          sessionId: ctx.resumeSessionId ?? "queued-session-1",
          transcript: "ok",
          rawStdout: "",
          rawStderr: "",
        };
      },
    };`,
  );
  writeAgent(
    dir,
    "queued-agent",
    `---
schemaVersion: 1
name: queued-agent
backend: queued-test
---
Queued agent.
`,
  );
  writeAssignment(
    dir,
    "daemon-work",
    `---
schemaVersion: 1
name: daemon-work
maxRetries: 0
---
Zero-task daemon work.
`,
  );

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let releaseInitialBackend;
  let releaseResumeBackend;
  globalThis.__queuedResumeBackendState = {
    invocations: [],
    releases: [
      new Promise((resolve) => {
        releaseInitialBackend = resolve;
      }),
      new Promise((resolve) => {
        releaseResumeBackend = resolve;
      }),
    ],
  };

  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_MIN_RECURRENCE_INTERVAL_SEC: "60" },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        const started = await client.call("runs.start", {
          agent: "queued-agent",
          assignment: "daemon-work",
          definitionCwd: dir,
          callerCwd: dir,
          cliVars: {},
          overrides: {},
        });
        const startedDetail = await client.call("runs.get", { target: started.runId });
        await waitForValue(
          () => (globalThis.__queuedResumeBackendState.invocations.length >= 1 ? true : null),
          "initial backend invocation",
        );
        const queued = await client.call("runs.queueResumeMessage", {
          target: started.runId,
          message: "Use the queued production path.",
        });

        releaseInitialBackend();
        await waitForValue(
          () => (globalThis.__queuedResumeBackendState.invocations.length >= 2 ? true : null),
          "queued resume backend invocation",
        );
        assert.match(
          globalThis.__queuedResumeBackendState.invocations[1].prompt,
          /Use the queued production path\./,
        );
        assert.equal(
          globalThis.__queuedResumeBackendState.invocations[1].resumeSessionId,
          "queued-session-1",
        );
        const originalSchedule = recurringSchedule(new Date(Date.now() - 60_000));
        setManifestSchedule(startedDetail.run.workspaceDir, originalSchedule);
        const drained = await waitForValue(async () => {
          const detail = await httpJson(httpBaseUrl, `/api/runs/${started.runId}`);
          assert.equal(detail.status, 200);
          return detail.body.run.queuedResumeMessages.length === 0 && detail.body.run.isLive
            ? detail.body.run
            : null;
        }, "queued resume messages to drain after accepted resume");
        assert.equal(drained.runId, started.runId);

        releaseResumeBackend();
        releaseResumeBackend = undefined;
        const drainedAudit = await waitForValue(async () => {
          const response = await httpJson(httpBaseUrl, `/api/runs/${started.runId}/audit`);
          assert.equal(response.status, 200);
          return response.body.history.events.find(
            (event) => event.event.type === "run.queued_resume_messages_drained",
          );
        }, "queued resume drain audit");
        assert.equal(drainedAudit.event.fields.messageCount, 1);
        assert.deepEqual(drainedAudit.event.fields.messageIds, [queued.queuedResumeMessage.id]);
        const advancedSchedule = await waitForValue(
          () => {
            const manifest = readManifest(startedDetail.run.workspaceDir);
            return manifest.schedule?.runAt !== originalSchedule.runAt ? manifest.schedule : null;
          },
          "recurring schedule to advance after queued resume drain",
          { attempts: 150 },
        );
        assert.equal(advancedSchedule.enabled, true);
        assert.equal(advancedSchedule.recurrence.mode, "reuse");
        assert.ok(new Date(advancedSchedule.runAt).getTime() > Date.now());
      } finally {
        releaseInitialBackend?.();
        releaseResumeBackend?.();
        globalThis.__queuedResumeBackendState = undefined;
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon drains queued resume messages before evaluating a due schedule", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  const dependent = await initRun(dir);
  setManifestSchedule(run.workspaceDir, oneTimeSchedule(new Date(Date.now() - 1_000)));

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let releaseInitialRun;
  let resolveQueuedResume;
  const queuedResumeStarted = new Promise((resolve) => {
    resolveQueuedResume = resolve;
  });
  const resumeMessages = [];
  const resumeTargets = [];
  let firstQueuedMessageId;
  let newerQueuedMessageId;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ emitEvent }) {
        markRunRunning(run.workspaceDir);
        emitRunStarted(emitEvent, run.runId, dir);
        await new Promise((resolve) => {
          releaseInitialRun = resolve;
        });
        markRunSuccessful(run.workspaceDir);
        emitRunFinished(emitEvent, run.runId);
        return { runId: run.runId };
      },
      async resumeRun({ target, overrides, emitEvent }) {
        resumeTargets.push(target);
        assert.equal(target, run.workspaceDir);
        resumeMessages.push(overrides.message ?? "");
        markRunRunning(run.workspaceDir);
        removeQueuedResumeMessageCommand({
          target: run.runId,
          messageId: firstQueuedMessageId,
        });
        const newerQueued = queueResumeMessageCommand({
          target: run.runId,
          message: "Newer queued follow-up.",
        });
        newerQueuedMessageId = newerQueued.queuedResumeMessage.id;
        emitRunStarted(emitEvent, run.runId, dir);
        resolveQueuedResume();
        return { runId: run.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.addDependency", {
        target: dependent.runId,
        dependency: { type: "run", runId: run.runId },
      });
      await client.call("runs.ready", { target: dependent.runId });
      await client.call("runs.start", { cliVars: {}, overrides: {} });
      const firstQueued = await client.call("runs.queueResumeMessage", {
        target: run.runId,
        message: "First queued follow-up.",
      });
      firstQueuedMessageId = firstQueued.queuedResumeMessage.id;
      await httpJson(httpBaseUrl, `/api/runs/${run.runId}/queued-resume-messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Second queued follow-up." }),
      });

      releaseInitialRun();
      await queuedResumeStarted;
      const drained = await waitForValue(async () => {
        const detail = await httpJson(httpBaseUrl, `/api/runs/${run.runId}`);
        assert.equal(detail.status, 200);
        return detail.body.run.queuedResumeMessages.length === 1 ? detail.body.run : null;
      }, "queued resume messages to drain");
      assert.equal(drained.runId, run.runId);
      assert.deepEqual(drained.queuedResumeMessages, [
        {
          id: newerQueuedMessageId,
          text: "Newer queued follow-up.",
          createdAt: drained.queuedResumeMessages[0].createdAt,
          source: null,
        },
      ]);
      assert.equal(resumeMessages.length, 1);
      assert.equal(resumeMessages[0], "First queued follow-up.\n\nSecond queued follow-up.");
      assert.doesNotMatch(resumeMessages[0], /Resuming after scheduled delay/);

      await sleep(100);
      assert.deepEqual(resumeTargets, [run.workspaceDir]);
      assert.equal(resumeMessages.length, 1);
      const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
      const drainedAudit = audit.body.history.events.find(
        (event) => event.event.type === "run.queued_resume_messages_drained",
      );
      assert.equal(drainedAudit.event.fields.messageCount, 1);
      assert.equal(JSON.stringify(audit.body).includes("queued follow-up"), false);
    } finally {
      releaseInitialRun?.();
      await client.close();
      await server.close();
    }
  });
});

test("daemon keeps queued resume messages when automatic resume start fails", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let releaseInitialRun;
  let resumeCalls = 0;
  const originalConsoleError = console.error;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ emitEvent }) {
        markRunRunning(run.workspaceDir);
        emitRunStarted(emitEvent, run.runId, dir);
        await new Promise((resolve) => {
          releaseInitialRun = resolve;
        });
        markRunSuccessful(run.workspaceDir);
        emitRunFinished(emitEvent, run.runId);
        return { runId: run.runId };
      },
      async resumeRun() {
        resumeCalls += 1;
        throw new Error("queued resume backend unavailable");
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    console.error = () => undefined;
    try {
      await client.call("runs.start", { cliVars: {}, overrides: {} });
      const queued = await client.call("runs.queueResumeMessage", {
        target: run.runId,
        message: "Preserve this queued intent.",
      });
      releaseInitialRun();
      const preserved = await waitForValue(async () => {
        const detail = await httpJson(httpBaseUrl, `/api/runs/${run.runId}`);
        assert.equal(detail.status, 200);
        return detail.body.run.status === "success" ? detail.body.run : null;
      }, "original run to finish");
      assert.equal(resumeCalls, 1);
      assert.deepEqual(preserved.queuedResumeMessages, [queued.queuedResumeMessage]);
    } finally {
      console.error = originalConsoleError;
      releaseInitialRun?.();
      await client.close();
      await server.close();
    }
  });
});

test("daemon parent completion delivery queues active parents once with compact child audit", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const parent = await initRun(dir);
  const child = await initRun(dir, "daemon-agent", { parentRunId: parent.runId });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let releaseParent;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ runId, emitEvent }) {
        if (runId === parent.runId) {
          setSyntheticSession(parent.workspaceDir, { status: "running" });
          emitRunStarted(emitEvent, parent.runId, dir);
          await new Promise((resolve) => {
            releaseParent = resolve;
          });
          return { runId: parent.runId };
        }
        assert.equal(runId, child.runId);
        setSyntheticSession(child.workspaceDir, { status: "running" });
        emitRunStarted(emitEvent, child.runId, dir);
        completeSyntheticSession(child.workspaceDir, {
          transcript: "child final transcript for parent",
        });
        emitRunFinished(emitEvent, child.runId);
        return { runId: child.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.start", {
        runId: parent.runId,
        cliVars: {},
        overrides: {},
      });
      await client.call("runs.start", {
        runId: child.runId,
        parentRunId: parent.runId,
        parentCompletionNotification: {
          source: "detached_invocation",
          parentRunId: parent.runId,
        },
        cliVars: {},
        overrides: {},
      });

      const notification = await waitForValue(() => {
        const record = readManifest(child.workspaceDir).parentCompletionNotifications[0];
        return record?.status === "delivered_queued" ? record : null;
      }, "child notification delivered_queued");
      assert.match(notification.id, /^pcn/);
      assert.equal(notification.parentRunId, parent.runId);
      assert.equal(notification.deliveryReason, "parent_active_queued");

      const parentDetail = await httpJson(httpBaseUrl, `/api/runs/${parent.runId}`);
      assert.equal(parentDetail.status, 200);
      assert.equal(parentDetail.body.run.queuedResumeMessages.length, 1);
      const [queued] = parentDetail.body.run.queuedResumeMessages;
      assert.equal(queued.source.childRunId, child.runId);
      assert.equal(queued.source.notificationId, notification.id);
      assert.match(queued.text, /Detached child run .* finished with status success/);
      assert.match(queued.text, /Inspect the child:/);
      assert.match(queued.text, /Child result:/);
      assert.match(queued.text, /agent-runner run status/);
      assert.match(queued.text, /child final transcript for parent/);

      const childAudit = await httpJson(httpBaseUrl, `/api/runs/${child.runId}/audit`);
      assert.equal(childAudit.status, 200);
      assert.equal(
        JSON.stringify(childAudit.body).includes("child final transcript for parent"),
        false,
      );
    } finally {
      releaseParent?.();
      await client.close();
      await server.close();
    }
  });
});

test("daemon parent completion delivery resumes idle parents with source metadata and truncation marker", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const parent = await initRun(dir);
  const child = await initRun(dir, "daemon-agent", { parentRunId: parent.runId });
  completeSyntheticSession(parent.workspaceDir, { transcript: "parent completed earlier" });

  const longTranscript = `${"x".repeat(12_100)}tail marker`;
  const resumeRequests = [];
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ runId, emitEvent }) {
        assert.equal(runId, child.runId);
        setSyntheticSession(child.workspaceDir, { status: "running" });
        emitRunStarted(emitEvent, child.runId, dir);
        completeSyntheticSession(child.workspaceDir, { transcript: longTranscript });
        emitRunFinished(emitEvent, child.runId);
        return { runId: child.runId };
      },
      async resumeRun({ target, overrides, resumeSource, emitEvent }) {
        assert.equal(target, parent.workspaceDir);
        resumeRequests.push({ message: overrides.message, resumeSource });
        setSyntheticSession(parent.workspaceDir, {
          sessionIndex: 1,
          status: "running",
          resumeSource,
        });
        emitEvent({
          type: "run_started",
          runId: parent.runId,
          agentName: "daemon-agent",
          assignmentSourcePath: null,
          name: "daemon-work",
          cwd: dir,
          sessionIndex: 1,
        });
        return { runId: parent.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.start", {
        runId: child.runId,
        parentRunId: parent.runId,
        parentCompletionNotification: {
          source: "detached_invocation",
          parentRunId: parent.runId,
        },
        cliVars: {},
        overrides: {},
      });
      const notification = await waitForValue(() => {
        const record = readManifest(child.workspaceDir).parentCompletionNotifications[0];
        return record?.status === "delivered_resumed" ? record : null;
      }, "child notification delivered_resumed");
      assert.equal(notification.deliveryReason, "parent_resumed");
      assert.equal(resumeRequests.length, 1);
      assert.deepEqual(resumeRequests[0].resumeSource, {
        kind: "parent_completion_notification",
        childRunId: child.runId,
        notificationId: notification.id,
      });
      assert.match(resumeRequests[0].message, /Detached child run/);
      assert.match(resumeRequests[0].message, /\[truncated\]/);
      assert.doesNotMatch(resumeRequests[0].message, /tail marker/);
      assert.deepEqual(readManifest(parent.workspaceDir).sessions[0].resumeSource, null);
      assert.deepEqual(readManifest(parent.workspaceDir).sessions[1].resumeSource, {
        kind: "parent_completion_notification",
        childRunId: child.runId,
        notificationId: notification.id,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon parent completion startup sweep is delivered-once and restart safe", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const parent = await initRun(dir);
  const child = await initRun(dir, "daemon-agent", { parentRunId: parent.runId });
  completeSyntheticSession(child.workspaceDir, { transcript: "already queued child result" });
  const notification = addPendingParentCompletionNotification(child.workspaceDir, {
    id: "pcn-restart-safe",
    parentRunId: parent.runId,
  });
  patchManifest(parent.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.queuedResumeMessages.push({
      id: "qmsg-existing-child-delivery",
      text: "Existing delivery from before daemon crash.",
      createdAt: "2026-04-21T12:07:00.000Z",
      source: {
        kind: "parent_completion_notification",
        childRunId: child.runId,
        notificationId: notification.id,
      },
    });
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const delivered = await waitForValue(() => {
        const record = readManifest(child.workspaceDir).parentCompletionNotifications[0];
        return record.status === "delivered_queued" ? record : null;
      }, "restart-safe notification delivered");
      assert.equal(delivered.deliveryReason, "parent_active_queued");
      assert.equal(readManifest(parent.workspaceDir).queuedResumeMessages.length, 1);
    } finally {
      await server.close();
    }
  });
});

test("daemon parent completion skips missing, not-resumable, stale, and non-terminal child sessions", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const notResumableParent = await initRun(dir);
  const missingParentChild = await initRun(dir);
  const notResumableChild = await initRun(dir);
  const staleChild = await initRun(dir);
  const nonTerminalChild = await initRun(dir);

  completeSyntheticSession(missingParentChild.workspaceDir);
  addPendingParentCompletionNotification(missingParentChild.workspaceDir, {
    id: "pcn-missing-parent",
    parentRunId: "missing-parent-run",
  });

  completeSyntheticSession(notResumableChild.workspaceDir);
  addPendingParentCompletionNotification(notResumableChild.workspaceDir, {
    id: "pcn-not-resumable",
    parentRunId: notResumableParent.runId,
  });

  completeSyntheticSession(staleChild.workspaceDir, { sessionIndex: 0, attemptNumber: 1 });
  completeSyntheticSession(staleChild.workspaceDir, { sessionIndex: 1, attemptNumber: 2 });
  addPendingParentCompletionNotification(staleChild.workspaceDir, {
    id: "pcn-stale-session",
    parentRunId: notResumableParent.runId,
    sessionIndex: 0,
  });

  setSyntheticSession(nonTerminalChild.workspaceDir, {
    status: "success",
    endedAt: "2026-04-21T12:05:00.000Z",
    sessionStatus: "running",
    sessionEndedAt: null,
  });
  addPendingParentCompletionNotification(nonTerminalChild.workspaceDir, {
    id: "pcn-child-not-terminal",
    parentRunId: notResumableParent.runId,
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      await waitForValue(() => {
        const missing = readManifest(missingParentChild.workspaceDir)
          .parentCompletionNotifications[0];
        const notResumable = readManifest(notResumableChild.workspaceDir)
          .parentCompletionNotifications[0];
        const stale = readManifest(staleChild.workspaceDir).parentCompletionNotifications[0];
        return missing.status === "skipped" &&
          notResumable.status === "skipped" &&
          stale.status === "skipped"
          ? true
          : null;
      }, "skipped parent completion notifications");

      assert.equal(
        readManifest(missingParentChild.workspaceDir).parentCompletionNotifications[0]
          .deliveryReason,
        "parent_not_found",
      );
      assert.equal(
        readManifest(notResumableChild.workspaceDir).parentCompletionNotifications[0]
          .deliveryReason,
        "parent_not_resumable",
      );
      assert.equal(
        readManifest(staleChild.workspaceDir).parentCompletionNotifications[0].deliveryReason,
        "notification_session_not_current",
      );
      assert.equal(
        readManifest(nonTerminalChild.workspaceDir).parentCompletionNotifications[0].status,
        "skipped",
      );
      assert.equal(
        readManifest(nonTerminalChild.workspaceDir).parentCompletionNotifications[0].deliveryReason,
        "child_session_not_terminal",
      );

      const audit = await httpJson(httpBaseUrl, `/api/runs/${nonTerminalChild.runId}/audit`);
      assert.equal(audit.status, 200);
      assert.ok(
        audit.body.history.events.some(
          (event) =>
            event.event.type === "run.parent_completion_notification_skipped" &&
            event.event.fields.deliveryReason === "child_session_not_terminal",
        ),
      );
    } finally {
      await server.close();
    }
  });
});

test("daemon parent completion marks unexpected delivery exceptions failed", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const parent = await initRun(dir);
  const child = await initRun(dir, "daemon-agent", { parentRunId: parent.runId });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let releaseParent;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ runId, emitEvent }) {
        if (runId === parent.runId) {
          setSyntheticSession(parent.workspaceDir, { status: "running" });
          emitRunStarted(emitEvent, parent.runId, dir);
          await new Promise((resolve) => {
            releaseParent = resolve;
          });
          return { runId: parent.runId };
        }
        assert.equal(runId, child.runId);
        setSyntheticSession(child.workspaceDir, { status: "running" });
        emitRunStarted(emitEvent, child.runId, dir);
        patchManifest(parent.workspaceDir, (manifest) => {
          manifest.status = "success";
          manifest.endedAt = "2026-04-21T12:04:00.000Z";
          manifest.exitCode = 0;
        });
        completeSyntheticSession(child.workspaceDir, { transcript: "failure-path child result" });
        emitRunFinished(emitEvent, child.runId);
        return { runId: child.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.start", {
        runId: parent.runId,
        cliVars: {},
        overrides: {},
      });
      await client.call("runs.start", {
        runId: child.runId,
        parentRunId: parent.runId,
        parentCompletionNotification: {
          source: "detached_invocation",
          parentRunId: parent.runId,
        },
        cliVars: {},
        overrides: {},
      });
      const failed = await waitForValue(() => {
        const record = readManifest(child.workspaceDir).parentCompletionNotifications[0];
        return record?.status === "failed" ? record : null;
      }, "failed parent completion notification");
      assert.equal(failed.deliveryReason, "delivery_exception");
      assert.match(failed.failureReason, /queue is only available while the run is live/);
      const audit = await httpJson(httpBaseUrl, `/api/runs/${child.runId}/audit`);
      assert.equal(audit.status, 200);
      assert.ok(
        audit.body.history.events.some(
          (event) =>
            event.event.type === "run.parent_completion_notification_failed" &&
            event.event.fields.deliveryReason === "delivery_exception",
        ),
      );
    } finally {
      releaseParent?.();
      await client.close();
      await server.close();
    }
  });
});

test("attached and web starts preserve parent lineage without completion notification intent", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const parent = await initRun(dir);
  const attachedChild = await initRun(dir, "daemon-agent", { parentRunId: parent.runId });
  const webChild = await initRun(dir, "daemon-agent", { parentRunId: parent.runId });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async startRun({ runId, emitEvent }) {
        assert.ok(runId === attachedChild.runId || runId === webChild.runId);
        const workspaceDir =
          runId === attachedChild.runId ? attachedChild.workspaceDir : webChild.workspaceDir;
        setSyntheticSession(workspaceDir, { status: "running" });
        emitRunStarted(emitEvent, runId, dir);
        completeSyntheticSession(workspaceDir);
        emitRunFinished(emitEvent, runId);
        return { runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.start", {
        runId: attachedChild.runId,
        parentRunId: parent.runId,
        cliVars: {},
        overrides: {},
      });
      const webStarted = await httpJson(httpBaseUrl, "/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: webChild.runId,
          parentRunId: parent.runId,
          webVars: {},
          overrides: {},
        }),
      });
      assert.equal(webStarted.status, 200);
      await waitForValue(() => {
        const attached = readManifest(attachedChild.workspaceDir);
        const web = readManifest(webChild.workspaceDir);
        return attached.status === "success" && web.status === "success" ? true : null;
      }, "attached and web children complete");
      assert.deepEqual(readManifest(attachedChild.workspaceDir).parentCompletionNotifications, []);
      assert.deepEqual(readManifest(webChild.workspaceDir).parentCompletionNotifications, []);
      assert.deepEqual(readManifest(parent.workspaceDir).queuedResumeMessages, []);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon does not auto-start zero-dependency ready runs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let autoStartCalls = 0;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun() {
        autoStartCalls += 1;
        throw new Error("zero-dependency ready run should not auto-start");
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.ready", { target: run.runId });
      await sleep(100);
      const ready = await waitForRunStatus(httpBaseUrl, run.runId, "ready");
      assert.equal(ready.runId, run.runId);
      assert.equal(autoStartCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon startup sweep auto-starts eligible ready dependency runs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const dependent = await initRun(dir);
  markRunSuccessful(source.workspaceDir);
  runCli(["run", "add-dep", dependent.runId, "--run", source.runId], { cwd: dir });
  runCli(["run", "ready", dependent.runId], { cwd: dir });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resolveAutoStarted;
  const autoStarted = new Promise((resolve) => {
    resolveAutoStarted = resolve;
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent }) {
        assert.equal(target, dependent.workspaceDir);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        resolveAutoStarted();
        return { runId: dependent.runId };
      },
    });
    try {
      await autoStarted;
      const running = await waitForRunStatus(httpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
    } finally {
      await server.close();
    }
  });
});

test("daemon suppresses duplicate dependency auto-start attempts while one is already pending", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const dependent = await initRun(dir);
  markRunSuccessful(source.workspaceDir);
  runCli(["run", "add-dep", dependent.runId, "--run", source.runId], { cwd: dir });
  runCli(["run", "ready", dependent.runId], { cwd: dir });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let autoStartCalls = 0;
  let releaseAutoStart;
  let resolveFirstCall;
  const firstCallSeen = new Promise((resolve) => {
    resolveFirstCall = resolve;
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      readyRun(target) {
        return getRunDetail(target);
      },
      async resumeRun({ target, emitEvent }) {
        autoStartCalls += 1;
        assert.equal(target, dependent.workspaceDir);
        resolveFirstCall();
        await new Promise((resolve) => {
          releaseAutoStart = resolve;
        });
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        return { runId: dependent.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await firstCallSeen;
      const readyResult = await client.call("runs.ready", { target: dependent.runId });
      assert.equal(readyResult.run.runId, dependent.runId);
      await sleep(50);
      assert.equal(autoStartCalls, 1);
      releaseAutoStart();
      const running = await waitForRunStatus(httpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon scheduler defers due one-time schedules during pending dependency auto-starts", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const dependent = await initRun(dir);
  markRunSuccessful(source.workspaceDir);
  runCli(["run", "add-dep", dependent.runId, "--run", source.runId], { cwd: dir });
  runCli(["run", "ready", dependent.runId], { cwd: dir });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let autoStartCalls = 0;
  let releaseAutoStart;
  let resolveFirstCall;
  const firstCallSeen = new Promise((resolve) => {
    resolveFirstCall = resolve;
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      readyRun(target) {
        return getRunDetail(target);
      },
      async resumeRun({ target, emitEvent }) {
        autoStartCalls += 1;
        assert.equal(target, dependent.workspaceDir);
        resolveFirstCall();
        await new Promise((resolve) => {
          releaseAutoStart = resolve;
        });
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        return { runId: dependent.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await firstCallSeen;
      setManifestSchedule(dependent.workspaceDir, oneTimeSchedule(new Date(Date.now() - 1_000)));
      await client.call("runs.setNote", {
        target: dependent.runId,
        note: "trigger schedule scan while dependency auto-start is pending",
      });
      await sleep(100);
      assert.notEqual(readManifest(dependent.workspaceDir).schedule, null);
      assert.equal(autoStartCalls, 1);
      const audit = await httpJson(httpBaseUrl, `/api/runs/${dependent.runId}/audit`);
      assert.equal(
        audit.body.history.events.some(
          (event) =>
            event.event.type === "run.schedule_missed" &&
            event.event.fields.reason === "already_active",
        ),
        false,
      );
      releaseAutoStart();
      const running = await waitForRunStatus(httpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon clears pending dependency auto-start markers after resume failures", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  const dependent = await initRun(dir);
  markRunSuccessful(source.workspaceDir);
  runCli(["run", "add-dep", dependent.runId, "--run", source.runId], { cwd: dir });
  runCli(["run", "ready", dependent.runId], { cwd: dir });

  const firstPort = await freePort();
  const firstListenUrl = `ws://127.0.0.1:${firstPort}/`;
  const firstHttpBaseUrl = deriveHttpBaseUrl(firstListenUrl);
  let failedCalls = 0;
  let releaseFailure;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const failingServer = await serveDaemon(firstListenUrl, {
      async resumeRun({ target }) {
        failedCalls += 1;
        assert.equal(target, dependent.workspaceDir);
        await new Promise((resolve) => {
          releaseFailure = resolve;
        });
        throw new Error("synthetic dependency auto-start failure");
      },
    });
    const summaries = await openSse(firstHttpBaseUrl, "/api/events/run-summaries");
    try {
      releaseFailure();
      const recoverySummary = await summaries.next();
      await sleep(100);
      const ready = await waitForRunStatus(firstHttpBaseUrl, dependent.runId, "ready");
      assert.equal(recoverySummary.type, "summary_upsert");
      assert.equal(recoverySummary.summary.runId, dependent.runId);
      assert.equal(recoverySummary.summary.status, "ready");
      assert.equal(ready.runId, dependent.runId);
      assert.equal(failedCalls, 1);
    } finally {
      await summaries.close();
      await failingServer.close();
    }

    const retryPort = await freePort();
    const retryListenUrl = `ws://127.0.0.1:${retryPort}/`;
    const retryHttpBaseUrl = deriveHttpBaseUrl(retryListenUrl);
    let retriedCalls = 0;
    let resolveRetryStarted;
    const retryStarted = new Promise((resolve) => {
      resolveRetryStarted = resolve;
    });
    const retryServer = await serveDaemon(retryListenUrl, {
      async resumeRun({ target, emitEvent }) {
        retriedCalls += 1;
        assert.equal(target, dependent.workspaceDir);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, dependent.runId, dir);
        resolveRetryStarted();
        return { runId: dependent.runId };
      },
    });
    try {
      await retryStarted;
      const running = await waitForRunStatus(retryHttpBaseUrl, dependent.runId, "running");
      assert.equal(running.runId, dependent.runId);
      assert.equal(retriedCalls, 1);
    } finally {
      await retryServer.close();
    }
  });
});

test("daemon scheduler marks startup-overdue one-time schedules missed without starting", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunReady(run.workspaceDir);
  setManifestSchedule(run.workspaceDir, oneTimeSchedule(new Date(Date.now() - 60_000)));

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun() {
        resumeCalls += 1;
        throw new Error("startup-overdue schedule should not start");
      },
    });
    try {
      assert.equal(readManifest(run.workspaceDir).schedule, null);
      await waitForValue(
        () => (readManifest(run.workspaceDir).schedule === null ? true : null),
        "startup-overdue schedule to clear",
      );
      const detail = await httpJson(httpBaseUrl, `/api/runs/${run.runId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.status, "ready");
      assert.equal(detail.body.run.schedule, null);
      const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
      const missed = audit.body.history.events.find(
        (event) => event.event.type === "run.schedule_missed",
      );
      assert.equal(missed?.event.fields.reason, "overdue_on_startup");
      assert.equal(resumeCalls, 0);
    } finally {
      await server.close();
    }
  });
});

test("daemon scheduler rebuilds future timers after schedule mutations and starts due runs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunReady(run.workspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.workspaceDir);
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.status = "running";
            manifest.schedule = null;
          });
          emitRunStarted(emitEvent, run.runId, dir);
          resolveStarted();
          return { runId: run.runId };
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        const scheduled = await client.call("runs.setSchedule", {
          target: run.runId,
          schedule: { delay: "1s" },
        });
        assert.equal(scheduled.run.scheduleState, "future");

        await started;
        const running = await waitForRunStatus(httpBaseUrl, run.runId, "running");
        assert.equal(running.schedule, null);
        assert.equal(resumeCalls, 1);
        const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
        assert.ok(
          audit.body.history.events.some((event) => event.event.type === "run.schedule_due"),
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon scheduler rejects manual starts while a scheduled start is pending", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunReady(run.workspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;
  let releaseScheduledStart;
  let resolveScheduledStart;
  const scheduledStartSeen = new Promise((resolve) => {
    resolveScheduledStart = resolve;
  });

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.workspaceDir);
          resolveScheduledStart();
          await new Promise((resolve) => {
            releaseScheduledStart = resolve;
          });
          markRunRunning(run.workspaceDir);
          emitRunStarted(emitEvent, run.runId, dir);
          return { runId: run.runId };
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        await client.call("runs.setSchedule", {
          target: run.runId,
          schedule: { delay: "1s" },
        });
        await scheduledStartSeen;

        await assert.rejects(
          () => client.call("runs.resume", { target: run.runId, overrides: {} }),
          (err) =>
            err instanceof DaemonRpcError &&
            err.code === -32003 &&
            err.message === `run ${run.runId} has a scheduled start in progress`,
        );
        await assert.rejects(
          () => client.call("runs.ready", { target: run.runId }),
          (err) =>
            err instanceof DaemonRpcError &&
            err.code === -32003 &&
            err.message === `run ${run.runId} has a scheduled start in progress`,
        );
        assert.equal(resumeCalls, 1);

        releaseScheduledStart();
        const running = await waitForRunStatus(httpBaseUrl, run.runId, "running");
        assert.equal(running.runId, run.runId);
      } finally {
        releaseScheduledStart?.();
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon scheduler records failed starts without immediately requeueing the same due schedule", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunReady(run.workspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun() {
          resumeCalls += 1;
          throw new Error("synthetic scheduled start failure");
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        await client.call("runs.setSchedule", {
          target: run.runId,
          schedule: { delay: "1s" },
        });

        await waitForValue(async () => {
          const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
          return audit.body.history.events.find(
            (event) => event.event.type === "run.schedule_failed",
          );
        }, "schedule failure audit event");

        await sleep(1_500);
        const manifest = readManifest(run.workspaceDir);
        assert.equal(resumeCalls, 1);
        assert.equal(manifest.status, "ready");
        assert.equal(manifest.schedule.enabled, true);
        const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
        const failed = audit.body.history.events.filter(
          (event) => event.event.type === "run.schedule_failed",
        );
        assert.equal(failed.length, 1);
        assert.equal(failed[0].event.fields.reason, "start_failed");
        assert.match(failed[0].event.fields.error, /synthetic scheduled start failure/);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon scheduler resumes completed runs for due one-time schedules", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunSuccessful(run.workspaceDir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, overrides, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.workspaceDir);
          assert.equal(overrides.message, "Resuming after scheduled delay.");
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.status = "running";
            manifest.endedAt = null;
            manifest.exitCode = null;
            manifest.schedule = null;
          });
          emitRunStarted(emitEvent, run.runId, dir);
          resolveStarted();
          return { runId: run.runId };
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        const scheduled = await client.call("runs.setSchedule", {
          target: run.runId,
          schedule: { delay: "1s" },
        });
        assert.equal(scheduled.run.scheduleState, "future");

        await Promise.race([
          started,
          sleep(3_000).then(() => {
            throw new Error("timed out waiting for completed scheduled run to resume");
          }),
        ]);
        const running = await waitForRunStatus(httpBaseUrl, run.runId, "running");
        assert.equal(running.schedule, null);
        assert.equal(resumeCalls, 1);
        const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
        assert.ok(
          audit.body.history.events.some((event) => event.event.type === "run.schedule_due"),
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon scheduler resumes recurring reuse runs with a synthetic message after prior sessions", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "ready";
    manifest.endedAt = null;
    manifest.exitCode = null;
    manifest.totalAttemptCount = 1;
    manifest.totalSessionCount = 1;
    manifest.backendSessionId = "thread-reuse";
    manifest.tasksCompleted = manifest.tasksTotal;
    for (const task of Object.values(manifest.finalTasks)) {
      task.status = "completed";
    }
    manifest.sessions = [
      {
        sessionIndex: 0,
        startedAt: "2026-04-25T13:00:00.000Z",
        endedAt: "2026-04-25T13:00:05.000Z",
        status: "success",
        exitCode: 0,
        message: "seed message",
        brief: "seed brief",
        firstAttemptNumber: 1,
        lastAttemptNumber: 1,
        maxAttemptsPerSession: 2,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "thread-reuse",
        resumeSource: null,
        provenance: { kind: "task_runner" },
      },
    ];
    manifest.attemptRecords = [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-25T13:00:00.000Z",
        endedAt: "2026-04-25T13:00:05.000Z",
        prompt: "prompt 1",
        sessionIdAtStart: null,
        sessionIdCaptured: "thread-reuse",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "done",
        logPath: "attempts/01.json",
        invalidStatuses: [],
        provenance: { kind: "task_runner" },
      },
    ];
    manifest.schedule = recurringSchedule(new Date(Date.now() + 1_000));
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, overrides, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.workspaceDir);
          assert.equal(overrides.message, "Resuming after scheduled delay.");
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.status = "running";
            manifest.endedAt = null;
            manifest.exitCode = null;
          });
          emitRunStarted(emitEvent, run.runId, dir);
          resolveStarted();
          return { runId: run.runId };
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        await Promise.race([
          started,
          sleep(4_000).then(() => {
            throw new Error("timed out waiting for recurring reuse scheduled run to resume");
          }),
        ]);
        const running = await waitForRunStatus(httpBaseUrl, run.runId, "running");
        assert.equal(running.runId, run.runId);
        assert.equal(resumeCalls, 1);
        const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
        assert.ok(
          audit.body.history.events.some((event) => event.event.type === "run.schedule_due"),
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon scheduler indexes clones created while a run is active", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir);
  markRunReady(source.workspaceDir);
  const cloneRunId = "daemon-clone-indexed";
  const cloneWorkspaceDir = join(source.workspaceDir, "..", cloneRunId);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const resumeTargets = [];
  let resolveCloneStarted;
  const cloneStarted = new Promise((resolve) => {
    resolveCloneStarted = resolve;
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent, emitAuditEnvelope }) {
        resumeTargets.push(target);
        if (target === source.workspaceDir) {
          const sourceManifest = readManifest(source.workspaceDir);
          mkdirSync(cloneWorkspaceDir, { recursive: true });
          writeFileSync(
            join(cloneWorkspaceDir, "run.json"),
            `${JSON.stringify(
              {
                ...sourceManifest,
                runId: cloneRunId,
                workspaceDir: cloneWorkspaceDir,
                status: "ready",
                startedAt: new Date().toISOString(),
                endedAt: null,
                exitCode: null,
                schedule: oneTimeSchedule(new Date(Date.now() - 1_000)),
              },
              null,
              2,
            )}\n`,
          );
          emitAuditEnvelope({
            runId: cloneRunId,
            cursor: 1,
            event: {
              type: "run.created",
              recordedAt: new Date().toISOString(),
              source: "daemon",
              hostMode: "daemon",
              fields: {
                agentName: "daemon-agent",
                assignmentName: "daemon-work",
                passive: false,
              },
            },
          });
          markRunRunning(source.workspaceDir);
          emitRunStarted(emitEvent, source.runId, dir);
          return { runId: source.runId };
        }

        assert.equal(target, cloneWorkspaceDir);
        patchManifest(cloneWorkspaceDir, (manifest) => {
          manifest.status = "running";
          manifest.schedule = null;
        });
        emitRunStarted(emitEvent, cloneRunId, dir);
        resolveCloneStarted();
        return { runId: cloneRunId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.resume", { target: source.runId, overrides: {} });
      await cloneStarted;
      const running = await waitForRunStatus(httpBaseUrl, cloneRunId, "running");
      assert.equal(running.runId, cloneRunId);
      assert.equal(running.schedule, null);
      assert.deepEqual(resumeTargets, [source.workspaceDir, cloneWorkspaceDir]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon projections skip task-state filesystem locks by default", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  const lockPath = join(run.workspaceDir, ".task-state.lock");
  mkdirSync(lockPath);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_DAEMON_FILESYSTEM_LOCKS: undefined,
    },
    async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const startedAt = Date.now();
        const detail = await httpJson(httpBaseUrl, `/api/runs/${run.runId}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.run.runId, run.runId);
        assert.ok(Date.now() - startedAt < 2_000, "projection should not wait on stale locks");
      } finally {
        await server.close();
        rmSync(lockPath, { recursive: true, force: true });
      }
    },
  );
});

test("daemon can opt into deferring run.created projection until task-state lock is released", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_DAEMON_FILESYSTEM_LOCKS: "true" },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async startRun({ emitEvent, emitAuditEnvelope }) {
          withTaskStateLock(run.workspaceDir, () => {
            emitAuditEnvelope({
              runId: run.runId,
              cursor: 2,
              event: {
                type: "run.created",
                recordedAt: new Date().toISOString(),
                source: "daemon",
                hostMode: "daemon",
                fields: {
                  agentName: "daemon-agent",
                  assignmentName: "daemon-work",
                  passive: false,
                },
              },
            });
          });
          markRunRunning(run.workspaceDir);
          emitRunStarted(emitEvent, run.runId, dir);
          return { runId: run.runId };
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        const startedAt = Date.now();
        const started = await client.call("runs.start", { cliVars: {}, overrides: {} });
        assert.equal(started.runId, run.runId);
        assert.ok(Date.now() - startedAt < 2_000, "runs.start should not wait on its own lock");
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon scheduler misses due one-time schedules that are not runnable", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const blocker = await initRun(dir);
  const dependencyBlocked = await initRun(dir);
  const archived = await initRun(dir);
  const notReady = await initRun(dir);
  const runAt = new Date(Date.now() + 1_000);

  markRunReady(dependencyBlocked.workspaceDir);
  markRunReady(archived.workspaceDir);
  patchManifest(dependencyBlocked.workspaceDir, (manifest) => {
    manifest.dependencies = [{ type: "run", runId: blocker.runId }];
    manifest.schedule = oneTimeSchedule(runAt);
  });
  patchManifest(archived.workspaceDir, (manifest) => {
    manifest.archivedAt = new Date().toISOString();
    manifest.schedule = oneTimeSchedule(runAt);
  });
  setManifestSchedule(notReady.workspaceDir, oneTimeSchedule(runAt));

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun() {
        throw new Error("non-runnable schedules should not start");
      },
    });
    try {
      await waitForValue(
        () =>
          [dependencyBlocked, archived, notReady].every(
            (candidate) => readManifest(candidate.workspaceDir).schedule === null,
          )
            ? true
            : null,
        { toString: () => "non-runnable schedules to clear" },
      );

      const expected = new Map([
        [dependencyBlocked.runId, "dependencies_unmet"],
        [archived.runId, "archived"],
        [notReady.runId, "not_ready"],
      ]);
      for (const [runId, reason] of expected) {
        const audit = await httpJson(httpBaseUrl, `/api/runs/${runId}/audit`);
        const missed = audit.body.history.events.find(
          (event) => event.event.type === "run.schedule_missed",
        );
        assert.equal(missed?.event.fields.reason, reason);
      }
    } finally {
      await server.close();
    }
  });
});

test("daemon scheduler defers due one-time schedules while a scheduled run is active", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);
  markRunReady(run.workspaceDir);
  setManifestSchedule(run.workspaceDir, oneTimeSchedule(new Date(Date.now() + 80)));

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  let resumeCalls = 0;
  let resolveStarted;
  let releaseRun;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseRun = resolve;
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      async resumeRun({ target, emitEvent }) {
        resumeCalls += 1;
        assert.equal(target, run.workspaceDir);
        markRunRunning(run.workspaceDir);
        emitRunStarted(emitEvent, run.runId, dir);
        resolveStarted();
        await release;
        return { runId: run.runId };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await started;
      setManifestSchedule(run.workspaceDir, oneTimeSchedule(new Date(Date.now() - 1_000)));
      await client.call("runs.setNote", { target: run.runId, note: "trigger schedule scan" });
      await sleep(100);
      assert.notEqual(readManifest(run.workspaceDir).schedule, null);
      assert.equal(resumeCalls, 1);
      const audit = await httpJson(httpBaseUrl, `/api/runs/${run.runId}/audit`);
      assert.equal(
        audit.body.history.events.some(
          (event) =>
            event.event.type === "run.schedule_missed" &&
            event.event.fields.reason === "already_active",
        ),
        false,
      );
    } finally {
      releaseRun();
      await client.close();
      await server.close();
    }
  });
});

test("daemon scheduler advances missed recurring schedules and disables invalid recurrence intervals", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const hourly = await initRun(dir);
  const tooFrequent = await initRun(dir);
  const corrupt = await initRun(dir);
  markRunReady(hourly.workspaceDir);
  markRunReady(tooFrequent.workspaceDir);
  markRunReady(corrupt.workspaceDir);
  const originalHourlySchedule = recurringSchedule(new Date(Date.now() - 3_600_000), "0 * * * *");
  setManifestSchedule(hourly.workspaceDir, originalHourlySchedule);
  setManifestSchedule(tooFrequent.workspaceDir, recurringSchedule(new Date(Date.now() - 60_000)));
  setManifestSchedule(
    corrupt.workspaceDir,
    recurringSchedule(new Date(Date.now() - 60_000), "not cron"),
  );

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_MIN_RECURRENCE_INTERVAL_SEC: "120",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun() {
          throw new Error("startup-overdue recurring schedule should not start");
        },
      });
      try {
        await waitForValue(() => {
          const hourlySchedule = readManifest(hourly.workspaceDir).schedule;
          const frequentSchedule = readManifest(tooFrequent.workspaceDir).schedule;
          const corruptSchedule = readManifest(corrupt.workspaceDir).schedule;
          return hourlySchedule?.runAt !== originalHourlySchedule.runAt &&
            frequentSchedule?.enabled === false &&
            corruptSchedule?.enabled === false
            ? true
            : null;
        }, "recurring schedules to advance or disable");

        const hourlyManifest = readManifest(hourly.workspaceDir);
        const frequentManifest = readManifest(tooFrequent.workspaceDir);
        const corruptManifest = readManifest(corrupt.workspaceDir);
        assert.equal(hourlyManifest.schedule.enabled, true);
        assert.ok(new Date(hourlyManifest.schedule.runAt).getTime() > Date.now());
        assert.equal(frequentManifest.schedule.enabled, false);
        assert.equal(corruptManifest.schedule.enabled, false);

        const hourlyAudit = await httpJson(httpBaseUrl, `/api/runs/${hourly.runId}/audit`);
        assert.ok(
          hourlyAudit.body.history.events.some(
            (event) =>
              event.event.type === "run.schedule_advanced" &&
              event.event.fields.reason === "overdue_on_startup",
          ),
        );
        const frequentAudit = await httpJson(httpBaseUrl, `/api/runs/${tooFrequent.runId}/audit`);
        assert.ok(
          frequentAudit.body.history.events.some(
            (event) =>
              event.event.type === "run.schedule_disabled" &&
              event.event.fields.reason === "minimum_interval_violation",
          ),
        );
        const corruptAudit = await httpJson(httpBaseUrl, `/api/runs/${corrupt.runId}/audit`);
        assert.ok(
          corruptAudit.body.history.events.some(
            (event) =>
              event.event.type === "run.schedule_disabled" &&
              event.event.fields.reason === "minimum_interval_violation",
          ),
        );
      } finally {
        await server.close();
      }
    },
  );
});

test("daemon note and pin mutations publish summary and detail updates", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl, {
      getRunList() {
        throw new Error("unexpected getRunList call during note/pin mutation publish");
      },
    });
    const summaries = await openSse(httpBaseUrl, "/api/events/run-summaries");
    const details = await openSse(httpBaseUrl, `/api/runs/${init.runId}/events/detail`);
    try {
      const noteResponse = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/note`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "SSE note" }),
      });
      assert.equal(noteResponse.status, 200);
      assert.deepEqual(noteResponse.body.result, {
        runId: init.runId,
        note: "SSE note",
        updatedAt: noteResponse.body.result.updatedAt,
        changed: true,
      });

      const noteSummary = await summaries.next();
      const noteDetail = await details.next();
      assert.equal(noteSummary.type, "summary_upsert");
      assert.equal(noteSummary.summary.runId, init.runId);
      assert.equal(noteSummary.summary.notePresent, true);
      assert.equal(noteDetail.type, "detail_updated");
      assert.equal(noteDetail.detail.runId, init.runId);
      assert.equal(noteDetail.detail.note, "SSE note");

      const pinResponse = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/pinned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      assert.equal(pinResponse.status, 200);
      assert.deepEqual(pinResponse.body.result, {
        runId: init.runId,
        pinned: true,
        updatedAt: pinResponse.body.result.updatedAt,
        changed: true,
      });

      const pinSummary = await summaries.next();
      const pinDetail = await details.next();
      assert.equal(pinSummary.type, "summary_upsert");
      assert.equal(pinSummary.summary.runId, init.runId);
      assert.equal(pinSummary.summary.pinned, true);
      assert.equal(pinDetail.type, "detail_updated");
      assert.equal(pinDetail.detail.runId, init.runId);
      assert.equal(pinDetail.detail.pinned, true);
    } finally {
      await summaries.close();
      await details.close();
      await server.close();
    }
  });
});

test("daemon mutation publishing suppresses stale-schema projection failures", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const projectionError = new ResumeError(
    "manifest at /tmp/stale/run.json has schemaVersion 13; this version of agent-runner requires schemaVersion 14",
  );

  const server = await serveDaemon(listenUrl, {
    updateRunNote(target, input) {
      return {
        runId: target,
        note: input.note,
        updatedAt: "2026-04-29T14:45:00.000Z",
        changed: true,
      };
    },
    getRunSummary() {
      throw projectionError;
    },
    getRun() {
      throw projectionError;
    },
  });
  try {
    const noted = await httpJson(httpBaseUrl, "/api/runs/stale-run/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "survives projection miss" }),
    });

    assert.equal(noted.status, 200);
    assert.deepEqual(noted.body.result, {
      runId: "stale-run",
      note: "survives projection miss",
      updatedAt: noted.body.result.updatedAt,
      changed: true,
    });

    const daemon = await httpJson(httpBaseUrl, "/api/daemon");
    assert.equal(daemon.status, 200);
  } finally {
    await server.close();
  }
});

test("daemon websocket validates events.subscribe channel and runId rules", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  const ws = await openRawWebSocket(listenUrl);
  try {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "events.subscribe",
        params: { channel: "bogus" },
      }),
    );
    const invalidChannel = await nextRawMessage(ws);
    assert.equal(
      invalidChannel.error.message,
      'channel must be one of "run_summary", "run_detail", "run_timeline", or "run_audit"',
    );

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "events.subscribe",
        params: { channel: "run_summary", runId: "run-123" },
      }),
    );
    const summaryWithRunId = await nextRawMessage(ws);
    assert.equal(summaryWithRunId.error.message, "runId must be omitted for channel run_summary");

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "events.subscribe",
        params: { channel: "run_detail" },
      }),
    );
    const missingRunId = await nextRawMessage(ws);
    assert.equal(missingRunId.error.message, "runId is required");
  } finally {
    ws.terminate();
    await server.close();
  }
});

test("daemon websocket stream frames reject unknown, cross-client, and out-of-order stream ids", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const first = await openRawWebSocket(listenUrl);
    const second = await openRawWebSocket(listenUrl);
    try {
      first.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "stream.data",
          params: { streamId: "stream-missing", seq: 0, data: Buffer.from("x").toString("base64") },
        }),
      );
      const unknown = await nextRawMessage(first);
      assert.equal(unknown.method, "stream.error");
      assert.equal(unknown.params.code, "STREAM_UNKNOWN");

      first.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "open",
          method: "attachments.upload.open",
          params: { runId: init.runId, name: "cross.txt", size: 1 },
        }),
      );
      const opened = await nextRawMessage(first);
      const streamId = opened.result.streamId;

      second.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "stream.data",
          params: { streamId, seq: 0, data: Buffer.from("x").toString("base64") },
        }),
      );
      const crossClient = await nextRawMessage(second);
      assert.equal(crossClient.method, "stream.error");
      assert.equal(crossClient.params.code, "STREAM_UNKNOWN");

      first.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "stream.data",
          params: { streamId, seq: 1, data: Buffer.from("x").toString("base64") },
        }),
      );
      const outOfOrder = await nextRawMessage(first);
      assert.equal(outOfOrder.method, "stream.error");
      assert.equal(outOfOrder.params.code, "STREAM_BAD_SEQUENCE");
    } finally {
      first.terminate();
      second.terminate();
      await server.close();
    }
  });
});

test("websocket stream registry enforces chunk, active stream, buffer, EOF, and idle limits", async (t) => {
  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    for (let index = 0; index < STREAM_MAX_ACTIVE_PER_CONNECTION; index += 1) {
      streams.openIncomingStream(`stream-${index}`);
    }
    assert.throws(() => streams.openIncomingStream("stream-over-limit"), /too many active streams/);
    streams.close();
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    streams.openIncomingStream("stream-chunk");
    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.data",
      params: {
        streamId: "stream-chunk",
        seq: 0,
        data: Buffer.alloc(STREAM_MAX_CHUNK_BYTES + 1).toString("base64"),
      },
    });
    await flushMicrotasks();
    assert.equal(ws.sent.at(-1).params.code, "STREAM_CHUNK_SIZE");
    streams.close();
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    const chunk = Buffer.alloc(STREAM_MAX_CHUNK_BYTES).toString("base64");
    streams.openIncomingStream("stream-buffer");
    const allowedChunks = STREAM_MAX_BUFFERED_BYTES_PER_STREAM / STREAM_MAX_CHUNK_BYTES;
    for (let seq = 0; seq < allowedChunks; seq += 1) {
      streams.handleFrame({
        jsonrpc: "2.0",
        method: "stream.data",
        params: { streamId: "stream-buffer", seq, data: chunk },
      });
    }
    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.data",
      params: { streamId: "stream-buffer", seq: allowedChunks, data: chunk },
    });
    await flushMicrotasks();
    assert.equal(ws.sent.at(-1).params.code, "STREAM_BUFFER_LIMIT");
    streams.close();
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    const chunk = Buffer.alloc(STREAM_MAX_CHUNK_BYTES).toString("base64");
    const chunksPerStream = STREAM_MAX_BUFFERED_BYTES_PER_STREAM / STREAM_MAX_CHUNK_BYTES;
    const fullStreams =
      STREAM_MAX_BUFFERED_BYTES_PER_CONNECTION / STREAM_MAX_BUFFERED_BYTES_PER_STREAM;
    for (let streamIndex = 0; streamIndex < fullStreams; streamIndex += 1) {
      const streamId = `stream-connection-${streamIndex}`;
      streams.openIncomingStream(streamId);
      for (let seq = 0; seq < chunksPerStream; seq += 1) {
        streams.handleFrame({
          jsonrpc: "2.0",
          method: "stream.data",
          params: { streamId, seq, data: chunk },
        });
      }
    }
    streams.openIncomingStream("stream-connection-overflow");
    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.data",
      params: { streamId: "stream-connection-overflow", seq: 0, data: chunk },
    });
    await flushMicrotasks();
    assert.equal(ws.sent.at(-1).params.code, "STREAM_BUFFER_LIMIT");
    streams.close();
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    streams.openIncomingStream("stream-ended");
    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.end",
      params: { streamId: "stream-ended", seq: 0 },
    });
    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.data",
      params: {
        streamId: "stream-ended",
        seq: 0,
        data: Buffer.from("late").toString("base64"),
      },
    });
    await flushMicrotasks();
    assert.equal(ws.sent.at(-1).params.code, "STREAM_BAD_SEQUENCE");
    streams.close();
  }

  {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    streams.openIncomingStream("stream-timeout");
    t.mock.timers.tick(STREAM_IDLE_TIMEOUT_MS);
    await flushMicrotasks();
    assert.equal(ws.sent.at(-1).params.code, "STREAM_TIMEOUT");
    streams.close();
  }
});

test("websocket stream registry applies byte-credit flow control", async () => {
  const initialWindowChunks = STREAM_INITIAL_WINDOW_BYTES / STREAM_MAX_CHUNK_BYTES;

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    streams.openOutgoingStream("stream-flow");
    const send = streams.sendIterable("stream-flow", [
      Buffer.alloc(STREAM_INITIAL_WINDOW_BYTES + 1),
    ]);
    await flushMicrotasks();
    assert.equal(
      ws.sent.filter((frame) => frame.method === "stream.data").length,
      initialWindowChunks,
    );
    assert.equal(
      ws.sent.some((frame) => frame.method === "stream.end"),
      false,
    );

    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId: "stream-flow", bytes: 1 },
    });
    await send;
    assert.equal(
      ws.sent.filter((frame) => frame.method === "stream.data").length,
      initialWindowChunks + 1,
    );
    assert.equal(ws.sent.at(-1).method, "stream.end");
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    streams.openOutgoingStream("stream-cancel");
    const send = streams.sendIterable("stream-cancel", [
      Buffer.alloc(STREAM_INITIAL_WINDOW_BYTES + 1),
    ]);
    await flushMicrotasks();
    streams.releaseStream(
      "stream-cancel",
      new WebSocketStreamError("stream-cancel was cancelled", "STREAM_CANCELLED"),
    );
    await assert.rejects(send, /stream-cancel was cancelled/);
    assert.equal(
      ws.sent.filter((frame) => frame.method === "stream.data").length,
      initialWindowChunks,
    );
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    streams.openOutgoingStream("stream-stale");
    streams.releaseStream("stream-stale");
    streams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId: "stream-stale", bytes: STREAM_MAX_CHUNK_BYTES },
    });
    assert.deepEqual(ws.sent, []);
  }

  {
    const firstWs = new FakeStreamWebSocket();
    const secondWs = new FakeStreamWebSocket();
    const firstStreams = new WebSocketStreamRegistry(firstWs);
    const secondStreams = new WebSocketStreamRegistry(secondWs);
    firstStreams.openOutgoingStream("stream-cross");
    const send = firstStreams.sendIterable("stream-cross", [
      Buffer.alloc(STREAM_INITIAL_WINDOW_BYTES + 1),
    ]);
    await flushMicrotasks();
    secondStreams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId: "stream-cross", bytes: 1 },
    });
    await flushMicrotasks();
    assert.equal(
      firstWs.sent.filter((frame) => frame.method === "stream.data").length,
      initialWindowChunks,
    );
    firstStreams.handleFrame({
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId: "stream-cross", bytes: 1 },
    });
    await send;
    secondStreams.close();
  }

  {
    const ws = new FakeStreamWebSocket();
    const streams = new WebSocketStreamRegistry(ws);
    const sends = [];
    for (let index = 0; index < STREAM_MAX_ACTIVE_PER_CONNECTION; index += 1) {
      const streamId = `stream-concurrent-${index}`;
      streams.openOutgoingStream(streamId);
      sends.push(streams.sendIterable(streamId, [Buffer.alloc(STREAM_INITIAL_WINDOW_BYTES + 1)]));
    }
    await flushMicrotasks();
    assert.equal(
      ws.sent.filter((frame) => frame.method === "stream.data").length,
      STREAM_MAX_ACTIVE_PER_CONNECTION * initialWindowChunks,
    );
    for (let index = 0; index < STREAM_MAX_ACTIVE_PER_CONNECTION; index += 1) {
      streams.handleFrame({
        jsonrpc: "2.0",
        method: "stream.window",
        params: { streamId: `stream-concurrent-${index}`, bytes: 1 },
      });
    }
    await Promise.all(sends);
  }
});

test("daemon websocket rejects non-stream notifications and keeps sibling RPCs working", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  const ws = await openRawWebSocket(listenUrl);
  try {
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "runs.list", params: {} }));
    const rejectedNotification = await nextRawMessage(ws);
    assert.equal(rejectedNotification.id, null);
    assert.equal(rejectedNotification.error.code, -32600);

    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "list", method: "runs.list", params: {} }));
    const list = await nextRawMessage(ws);
    assert.equal(list.id, "list");
    assert.ok(Array.isArray(list.result.runs));
  } finally {
    ws.terminate();
    await server.close();
  }
});

test("daemon client ignores malformed subscription notifications and still delivers valid ones", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const received = [];

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      if (request.method !== "events.subscribe") {
        return;
      }

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { subscriptionId: "sub-1" },
        }),
      );
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "run.timeline",
          params: {
            runId: "daemon-client-run",
            event: { type: "run_started" },
          },
        }),
      );
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "run.summary",
          params: {
            subscriptionId: "sub-1",
            summary: {},
          },
        }),
      );
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "run.detail",
          params: {
            subscriptionId: "sub-1",
            runId: "daemon-client-run",
            detail: { runId: "daemon-client-run" },
          },
        }),
      );
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "run.timeline",
          params: {
            subscriptionId: "sub-1",
            runId: "daemon-client-run",
            cursor: 1,
            event: { type: "run_started" },
          },
        }),
      );
    });
  });

  const client = await DaemonClient.connect(listenUrl);
  try {
    await client.subscribe({ channel: "run_timeline", runId: "daemon-client-run" }, (msg) => {
      received.push(msg);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(received, [
      {
        method: "run.timeline",
        subscriptionId: "sub-1",
        runId: "daemon-client-run",
        cursor: 1,
        event: { type: "run_started" },
      },
    ]);
  } finally {
    await client.close();
    for (const socket of wsServer.clients) {
      socket.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon client rejects pending calls when a frame is malformed JSON", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });

  wsServer.on("connection", (ws) => {
    ws.on("message", () => {
      ws.send("{not-json");
    });
  });

  const client = await DaemonClient.connect(listenUrl);
  try {
    await assert.rejects(
      client.call("runs.list", {}),
      (err) =>
        err instanceof DaemonRpcError &&
        err.code === -32700 &&
        /malformed JSON-RPC/.test(err.message),
    );
  } finally {
    await client.close().catch(() => {});
    for (const socket of wsServer.clients) {
      socket.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon SSE streams split summary, detail, and timeline subscriptions", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-sse-run";
  let status = "initialized";
  let activeTask = null;
  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon sse",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: status === "aborted" ? "2026-04-13T05:05:00.000Z" : null,
        exitCode: status === "aborted" ? 130 : null,
        totalAttemptCount: 1,
        maxAttemptsPerSession: 1,
        totalSessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 1,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [
          {
            id: "t1",
            title: "First",
            body: "",
            status: activeTask ? "in_progress" : "pending",
            notes: "",
          },
        ],
        activeTask,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status,
          effectiveStatus: status,
          archivedAt: null,
          agentName: "daemon-agent",
          name: "daemon sse",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: status === "aborted" ? "2026-04-13T05:05:00.000Z" : null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: status === "running",
            abortReason: status === "running" ? undefined : "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, abortSignal }) {
      status = "running";
      activeTask = {
        id: "t1",
        title: "First",
      };
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "daemon sse",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({
        type: "attempt_started",
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-13T05:00:01.000Z",
        prompt: "SSE prompt",
      });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
            activeTask = null;
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                sessionAttemptCount: 1,
                totalAttemptCount: 1,
                maxAttemptsPerSession: 1,
                totalSessionCount: 1,
                tasksCompleted: 0,
                tasksTotal: 0,
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const allRuns = await openSse(httpBaseUrl, "/api/events/run-summaries");
  const oneRun = await openSse(httpBaseUrl, `/api/runs/${runId}/events/detail`);
  const timeline = await openSse(httpBaseUrl, `/api/runs/${runId}/events/timeline`);
  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webVars: {}, overrides: {} }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, runId);

    const allStarted = await allRuns.next();
    const oneStarted = await oneRun.next();
    assert.equal(allStarted.type, "summary_upsert");
    assert.equal(allStarted.summary.runId, runId);
    assert.equal(allStarted.summary.status, "running");
    assert.equal(oneStarted.type, "detail_updated");
    assert.equal(oneStarted.detail.runId, runId);
    assert.equal(oneStarted.detail.status, "running");
    assert.equal((await timeline.next()).event.type, "run_started");
    assert.equal((await timeline.next()).event.type, "attempt_started");

    const aborted = await httpJson(httpBaseUrl, `/api/runs/${runId}/abort`, { method: "POST" });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.accepted, true);

    const allFinished = await allRuns.next();
    const oneFinished = await oneRun.next();
    assert.equal(allFinished.type, "summary_upsert");
    assert.equal(allFinished.summary.status, "aborted");
    assert.equal(oneFinished.type, "detail_updated");
    assert.equal(oneFinished.detail.status, "aborted");
    assert.equal((await timeline.next()).event.type, "run_aborted");
    assert.equal((await timeline.next()).event.type, "run_finished");
  } finally {
    await allRuns.close();
    await oneRun.close();
    await timeline.close();
    await server.close();
  }
});

test("daemon serves timeline history and cursored timeline replay over HTTP and websocket", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-timeline-history";
  let status = "initialized";
  let activeTask = null;

  const baseHistory = {
    runId,
    attempts: [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: "2026-04-13T05:02:00.000Z",
        prompt: "Initial prompt",
        transcript: "Completed output\n",
        notices: "Completed notice\n",
        exitCode: 0,
        timedOut: false,
        live: false,
      },
    ],
    lastCursor: 0,
  };

  const server = await serveDaemon(listenUrl, {
    getRunTimelineHistory() {
      return baseHistory;
    },
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon timeline history",
        backendSessionId: null,
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 60,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: status === "running" ? 2 : 1,
        maxAttemptsPerSession: 3,
        totalSessionCount: status === "running" ? 2 : 1,
        tasksCompleted: 1,
        tasksTotal: 1,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [],
        activeTask,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status,
          effectiveStatus: status,
          archivedAt: null,
          agentName: "daemon-agent",
          name: "daemon timeline history",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          tasksCompleted: 1,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: status === "running",
            abortReason: status === "running" ? undefined : "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, abortSignal }) {
      status = "running";
      activeTask = { id: "t1", title: "First" };
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "daemon timeline history",
        cwd: process.cwd(),
        sessionIndex: 1,
      });
      emitEvent({
        type: "attempt_started",
        attemptNumber: 2,
        sessionIndex: 1,
        attemptIndexInSession: 0,
        startedAt: "2026-04-13T05:03:00.000Z",
        prompt: "Resume prompt",
      });
      emitEvent({ type: "agent_message_delta", text: "Live output" });
      emitEvent({ type: "backend_notice", text: "\nLive notice\n" });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
            activeTask = null;
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                sessionAttemptCount: 1,
                totalAttemptCount: 2,
                maxAttemptsPerSession: 3,
                totalSessionCount: 2,
                tasksCompleted: 1,
                tasksTotal: 1,
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const started = await httpJson(httpBaseUrl, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ webVars: {}, overrides: {} }),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.runId, runId);

  const historyResponse = await httpJson(httpBaseUrl, `/api/runs/${runId}/timeline`);
  assert.equal(historyResponse.status, 200);
  assert.equal(historyResponse.body.history.lastCursor, 4);
  assert.equal(historyResponse.body.history.attempts.length, 2);
  assert.equal(historyResponse.body.history.attempts.filter((attempt) => attempt.live).length, 1);
  assert.equal(historyResponse.body.history.attempts[1].prompt, "Resume prompt");
  assert.equal(historyResponse.body.history.attempts[1].transcript, "Live output");
  assert.equal(historyResponse.body.history.attempts[1].notices, "\nLive notice\n");

  const sse = await openSseFrames(httpBaseUrl, `/api/runs/${runId}/events/timeline`);
  const client = await DaemonClient.connect(listenUrl);

  try {
    const wsEvents = [];
    await client.subscribe({ channel: "run_timeline", runId }, (msg) => {
      if (msg.method === "run.timeline") {
        wsEvents.push(msg);
      }
    });

    const wsHistory = await client.call("runs.timelineHistory", { target: runId });
    assert.equal(wsHistory.history.lastCursor, 4);
    assert.equal(wsHistory.history.attempts[1].live, true);

    const firstFrame = await sse.next();
    assert.equal(firstFrame.id, "1");
    assert.equal(firstFrame.data.cursor, 1);
    assert.equal(firstFrame.data.event.type, "run_started");

    const secondFrame = await sse.next();
    assert.equal(secondFrame.id, "2");
    assert.equal(secondFrame.data.event.type, "attempt_started");

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(wsEvents[0]?.cursor, 1);
    assert.equal(wsEvents[0]?.event.type, "run_started");
    assert.equal(wsEvents[1]?.cursor, 2);
    assert.equal(wsEvents[1]?.event.type, "attempt_started");
    assert.equal(wsEvents[2]?.cursor, 3);
    assert.equal(wsEvents[3]?.cursor, 4);

    const aborted = await httpJson(httpBaseUrl, `/api/runs/${runId}/abort`, { method: "POST" });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.accepted, true);
  } finally {
    await client.close();
    await sse.close();
    await server.close();
  }
});

test("daemon serves audit history and cursored audit replay over HTTP and websocket", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-audit-history";
  let status = "initialized";
  const persistedAudit = [];

  const server = await serveDaemon(listenUrl, {
    getRunAuditHistory() {
      return {
        runId,
        events: [...persistedAudit],
        lastCursor: persistedAudit.at(-1)?.cursor ?? 0,
      };
    },
    getRun() {
      return {
        runId,
        repo: "agent-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: null,
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon audit history",
        backendSessionId: null,
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 60,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: null,
        exitCode: null,
        totalAttemptCount: 1,
        maxAttemptsPerSession: 3,
        totalSessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 1,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [],
        activeTask: null,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
            canEditPending: false,
            canDeletePending: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "agent-runner",
          status,
          effectiveStatus: status,
          archivedAt: null,
          agentName: "daemon-agent",
          name: "daemon audit history",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask: null,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: status === "running",
            abortReason: status === "running" ? undefined : "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
              canEditPending: false,
              canDeletePending: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, emitAuditEnvelope, abortSignal }) {
      status = "running";
      const startedEnvelope = {
        runId,
        cursor: 1,
        event: {
          type: "run.started",
          recordedAt: "2026-04-13T05:00:00.000Z",
          source: "daemon",
          hostMode: "daemon",
          sessionIndex: 0,
          fields: {
            backend: "codex",
            name: "daemon audit history",
            cwd: "/tmp/fake",
            backendSessionIdAtStart: null,
          },
        },
      };
      persistedAudit.push(startedEnvelope);
      emitAuditEnvelope(startedEnvelope);
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "daemon audit history",
        cwd: process.cwd(),
        sessionIndex: 0,
      });

      const taskEnvelope = {
        runId,
        cursor: 2,
        event: {
          type: "task.updated",
          recordedAt: "2026-04-13T05:01:00.000Z",
          source: "daemon",
          hostMode: "daemon",
          fields: {
            taskId: "t1",
            taskTitle: "First",
            command: "set",
            statusBefore: "pending",
            statusAfter: "completed",
            notesChanged: false,
          },
        },
      };
      persistedAudit.push(taskEnvelope);
      emitAuditEnvelope(taskEnvelope);

      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
            const finishedEnvelope = {
              runId,
              cursor: 3,
              event: {
                type: "run.finished",
                recordedAt: "2026-04-13T05:02:00.000Z",
                source: "daemon",
                hostMode: "daemon",
                fields: {
                  terminalStatus: "aborted",
                  exitCode: null,
                  tasksCompleted: 1,
                  tasksTotal: 1,
                },
              },
            };
            persistedAudit.push(finishedEnvelope);
            emitAuditEnvelope(finishedEnvelope);
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                sessionAttemptCount: 1,
                totalAttemptCount: 1,
                maxAttemptsPerSession: 1,
                totalSessionCount: 1,
                tasksCompleted: 1,
                tasksTotal: 1,
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });

      return { runId };
    },
  });

  const started = await httpJson(httpBaseUrl, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ webVars: {}, overrides: {} }),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.runId, runId);

  const historyResponse = await httpJson(httpBaseUrl, `/api/runs/${runId}/audit`);
  assert.equal(historyResponse.status, 200);
  assert.equal(historyResponse.body.history.lastCursor, 2);
  assert.deepEqual(
    historyResponse.body.history.events.map((event) => event.cursor),
    [1, 2],
  );

  const sse = await openSseFrames(httpBaseUrl, `/api/runs/${runId}/events/audit`);
  const client = await DaemonClient.connect(listenUrl);

  try {
    const wsEvents = [];
    await client.subscribe({ channel: "run_audit", runId }, (msg) => {
      if (msg.method === "run.audit") {
        wsEvents.push(msg);
      }
    });

    const replayFrames = [await sse.next(), await sse.next()].sort(
      (left, right) => left.data.cursor - right.data.cursor,
    );
    assert.deepEqual(
      replayFrames.map((frame) => frame.data.cursor),
      [1, 2],
    );
    assert.deepEqual(
      replayFrames.map((frame) => frame.data.event.type),
      ["run.started", "task.updated"],
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(
      wsEvents.map((event) => event.cursor).sort((left, right) => left - right),
      [1, 2],
    );
    assert.deepEqual(
      wsEvents
        .slice()
        .sort((left, right) => left.cursor - right.cursor)
        .map((event) => event.event.type),
      ["run.started", "task.updated"],
    );

    const aborted = await httpJson(httpBaseUrl, `/api/runs/${runId}/abort`, { method: "POST" });
    assert.equal(aborted.status, 200);

    const finalFrame = await sse.next();
    assert.equal(finalFrame.id, "3");
    assert.equal(finalFrame.data.cursor, 3);
    assert.equal(finalFrame.data.event.type, "run.finished");
  } finally {
    await client.close();
    await sse.close();
    await server.close();
  }
});

test("daemon session sync polls subscribed detail runs, skips unchanged reads, and publishes synced detail", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-1")],
  });

  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      const seenAttemptCounts = [];
      const auditEvents = [];
      try {
        const subscriptionId = await client.subscribe(
          { channel: "run_detail", runId: run.runId },
          (event) => {
            if (event.method === "run.detail") {
              seenAttemptCounts.push(event.detail.totalAttemptCount);
            }
          },
        );
        const auditSubscriptionId = await client.subscribe(
          { channel: "run_audit", runId: run.runId },
          (event) => {
            if (event.method === "run.audit") {
              auditEvents.push(event.event.type);
            }
          },
        );

        await waitForValue(() => {
          const manifest = readManifest(run.workspaceDir);
          return manifest.attemptRecords.some(
            (attempt) =>
              attempt.provenance.kind === "backend_session" &&
              attempt.provenance.backendTurnId === "turn-1",
          )
            ? true
            : null;
        }, "daemon session sync to import turn-1");
        await waitForValue(() => (seenAttemptCounts.includes(1) ? true : null), "detail publish");
        await waitForValue(
          () => (auditEvents.includes("run.backend_session_history_synced") ? true : null),
          "sync audit publish",
        );

        const afterFirst = readSyncState(statePath);
        assert.equal(afterFirst.readCalls, 1);
        await waitForValue(() => {
          const state = readSyncState(statePath);
          return state.resolveCalls > afterFirst.resolveCalls && state.readCalls === 1
            ? true
            : null;
        }, "unchanged source polling without reread");

        const auditCountAfterFirst = auditEvents.filter(
          (eventType) => eventType === "run.backend_session_history_synced",
        ).length;
        writeSyncState(statePath, {
          token: "v1-noop",
          turns: [makeSyncedTurn("turn-1")],
        });
        await waitForValue(() => {
          const state = readSyncState(statePath);
          return state.readCalls > afterFirst.readCalls ? true : null;
        }, "noop changed source read");
        await sleep(150);
        assert.equal(
          auditEvents.filter((eventType) => eventType === "run.backend_session_history_synced")
            .length,
          auditCountAfterFirst,
        );

        writeSyncState(statePath, {
          token: "v2",
          turns: [makeSyncedTurn("turn-1"), makeSyncedTurn("turn-2", "2026-04-26T10:02:00.000Z")],
        });
        await waitForValue(() => {
          const manifest = readManifest(run.workspaceDir);
          return manifest.attemptRecords.some(
            (attempt) =>
              attempt.provenance.kind === "backend_session" &&
              attempt.provenance.backendTurnId === "turn-2",
          )
            ? true
            : null;
        }, "daemon session sync to import turn-2");
        await waitForValue(
          () => (seenAttemptCounts.includes(2) ? true : null),
          "second detail publish",
        );

        await client.unsubscribe(subscriptionId);
        await client.unsubscribe(auditSubscriptionId);
        const afterUnsubscribe = readSyncState(statePath);
        await sleep(350);
        assert.equal(readSyncState(statePath).resolveCalls, afterUnsubscribe.resolveCalls);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync ignores summary-only and running run subscriptions", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-1")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.backendSessionId = "sync-session";
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let releaseActiveRun;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async startRun({ emitEvent }) {
          markRunRunning(run.workspaceDir);
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.backendSessionId = "sync-session";
          });
          emitRunStarted(emitEvent, run.runId, dir);
          await new Promise((resolve) => {
            releaseActiveRun = resolve;
          });
          return { runId: run.runId };
        },
      });
      const client = await DaemonClient.connect(listenUrl);
      try {
        await client.call("runs.start", { cliVars: {}, overrides: {} });
        const summarySub = await client.subscribe({ channel: "run_summary" }, () => {});
        await sleep(350);
        assert.equal(readSyncState(statePath).resolveCalls, 0);
        await client.unsubscribe(summarySub);

        const detailSub = await client.subscribe(
          { channel: "run_detail", runId: run.runId },
          () => {},
        );
        await sleep(350);
        assert.equal(readSyncState(statePath).resolveCalls, 0);
        await client.unsubscribe(detailSub);
      } finally {
        releaseActiveRun?.();
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync is disabled by AGENT_RUNNER_BACKEND_SESSION_SYNC=false", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-disabled")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_SYNC_BACKEND_STATE: statePath,
      AGENT_RUNNER_BACKEND_SESSION_SYNC: "false",
    },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        const detailSub = await client.subscribe(
          { channel: "run_detail", runId: run.runId },
          () => {},
        );
        await sleep(650);
        assert.equal(readSyncState(statePath).resolveCalls, 0);
        assert.equal(readSyncState(statePath).readCalls, 0);
        assert.equal(readManifest(run.workspaceDir).attemptRecords.length, 0);
        await client.unsubscribe(detailSub);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync invalidates timeline subscribers after importing backend history", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-audit")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      const timelineEvents = [];
      const auditEvents = [];
      try {
        const timelineSub = await client.subscribe(
          { channel: "run_timeline", runId: run.runId },
          (event) => {
            if (event.method === "run.timeline") {
              timelineEvents.push(event.event.type);
            }
          },
        );
        const auditSub = await client.subscribe(
          { channel: "run_audit", runId: run.runId },
          (event) => {
            if (event.method === "run.audit") {
              auditEvents.push(event.event.type);
            }
          },
        );

        await waitForValue(() => {
          const manifest = readManifest(run.workspaceDir);
          return manifest.attemptRecords.some(
            (attempt) =>
              attempt.provenance.kind === "backend_session" &&
              attempt.provenance.backendTurnId === "turn-audit",
          )
            ? true
            : null;
        }, "timeline/audit subscription sync");
        await waitForValue(
          () => (auditEvents.includes("run.backend_session_history_synced") ? true : null),
          "sync audit event",
        );
        await waitForValue(
          () => (timelineEvents.includes("timeline_invalidated") ? true : null),
          "timeline invalidation event",
        );
        await client.unsubscribe(timelineSub);
        await client.unsubscribe(auditSub);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync publishes audit failures and persists lastError", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-before-failure")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
    manifest.backendSessionSync = {
      backend: "syncer",
      backendSessionId: "sync-session",
      source: { kind: "custom", label: "sync-fixture", changeToken: { token: "v0" } },
      cursor: { token: "v0" },
      lastSyncedAt: "2026-04-26T10:09:00.000Z",
      lastError: null,
      importedTurnIds: [],
      openTurnIds: [],
    };
  });
  writeSyncState(statePath, { token: "v2", failRead: true, turns: [makeSyncedTurn("turn-fail")] });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        const auditSub = await client.subscribe(
          { channel: "run_audit", runId: run.runId },
          () => {},
        );

        await waitForValue(async () => {
          const history = await daemonGetRunAuditHistory(listenUrl, run.runId);
          return history.events.some(
            ({ event }) =>
              event.type === "run.backend_session_history_sync_failed" &&
              String(event.fields.error).includes("fixture read failed"),
          )
            ? true
            : null;
        }, "daemon sync failure audit");
        assert.equal(
          readManifest(run.workspaceDir).backendSessionSync.lastError,
          "fixture read failed",
        );
        await client.unsubscribe(auditSub);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync skips busy task-state locks without failure audit", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-locked")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
    manifest.backendSessionSync = {
      backend: "syncer",
      backendSessionId: "sync-session",
      source: { kind: "custom", label: "sync-fixture", changeToken: { token: "v0" } },
      cursor: { token: "v0" },
      lastSyncedAt: "2026-04-26T10:09:00.000Z",
      lastError: null,
      importedTurnIds: [],
      openTurnIds: [],
    };
  });
  const lockPath = join(run.workspaceDir, ".task-state.lock");
  mkdirSync(lockPath);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      const auditEvents = [];
      try {
        const auditSub = await client.subscribe(
          { channel: "run_audit", runId: run.runId },
          (event) => {
            if (event.method === "run.audit") {
              auditEvents.push(event.event.type);
            }
          },
        );
        await sleep(650);

        const state = readSyncState(statePath);
        assert.equal(state.resolveCalls, 0);
        assert.equal(state.readCalls, 0);
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.backendSessionSync.lastError, null);
        assert.equal(manifest.attemptRecords.length, 0);
        assert.equal(auditEvents.includes("run.backend_session_history_sync_failed"), false);

        await client.unsubscribe(auditSub);
      } finally {
        await client.close();
        await server.close();
        rmSync(lockPath, { recursive: true, force: true });
      }
    },
  );
});

test("daemon session sync reads backend history outside the task-state lock", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    readDelayMs: 1_000,
    token: "v1",
    turns: [makeSyncedTurn("turn-delayed")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
    manifest.backendSessionSync = {
      backend: "syncer",
      backendSessionId: "sync-session",
      source: { kind: "custom", label: "sync-fixture", changeToken: { token: "v0" } },
      cursor: { token: "v0" },
      lastSyncedAt: "2026-04-26T10:09:00.000Z",
      lastError: null,
      importedTurnIds: [],
      openTurnIds: [],
    };
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        const detailSub = await client.subscribe(
          { channel: "run_detail", runId: run.runId },
          () => {},
        );
        await waitForValue(
          () => (readSyncState(statePath).readCalls > 0 ? true : null),
          "delayed backend history read to start",
        );

        assert.equal(existsSync(join(run.workspaceDir, ".task-state.lock")), false);
        runCli(["task", "append-notes", run.runId, "t1", "--text", "during backend read"], {
          cwd: dir,
        });
        assert.match(
          runCli(["task", "show", run.runId, "t1"], { cwd: dir }),
          /during backend read/,
        );

        await waitForValue(() => {
          const manifest = readManifest(run.workspaceDir);
          return manifest.attemptRecords.some(
            (attempt) =>
              attempt.provenance.kind === "backend_session" &&
              attempt.provenance.backendTurnId === "turn-delayed",
          )
            ? true
            : null;
        }, "delayed backend history sync to apply");
        await client.unsubscribe(detailSub);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync skips apply when sync state changes during backend read", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    readDelayMs: 1_000,
    token: "v1",
    turns: [makeSyncedTurn("turn-raced")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
    manifest.backendSessionSync = {
      backend: "syncer",
      backendSessionId: "sync-session",
      source: { kind: "custom", label: "sync-fixture", changeToken: { token: "v0" } },
      cursor: { token: "v0" },
      lastSyncedAt: "2026-04-26T10:09:00.000Z",
      lastError: null,
      importedTurnIds: [],
      openTurnIds: [],
    };
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        const detailSub = await client.subscribe(
          { channel: "run_detail", runId: run.runId },
          () => {},
        );
        await waitForValue(
          () => (readSyncState(statePath).readCalls > 0 ? true : null),
          "raced backend history read to start",
        );
        patchManifest(run.workspaceDir, (manifest) => {
          manifest.backendSessionSync = {
            backend: "syncer",
            backendSessionId: "sync-session",
            source: { kind: "custom", label: "sync-fixture", changeToken: { token: "external" } },
            cursor: { token: "external" },
            lastSyncedAt: "2026-04-26T10:09:30.000Z",
            lastError: null,
            importedTurnIds: [],
            openTurnIds: [],
          };
        });
        await client.unsubscribe(detailSub);
        await sleep(1_200);

        const manifest = readManifest(run.workspaceDir);
        assert.equal(
          manifest.attemptRecords.some(
            (attempt) =>
              attempt.provenance.kind === "backend_session" &&
              attempt.provenance.backendTurnId === "turn-raced",
          ),
          false,
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});

test("daemon session sync close clears pending poll timers", async () => {
  const dir = tempDir();
  const statePath = join(dir, "sync-state.json");
  writeAgent(dir, "sync-daemon-agent", SYNC_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  writeSyncBackend(dir);
  writeSyncState(statePath, {
    token: "v1",
    turns: [makeSyncedTurn("turn-1")],
  });
  const run = await initRun(dir, "sync-daemon-agent");
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = "2026-04-26T10:10:00.000Z";
    manifest.backendSessionId = "sync-session";
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(
    { ...sharedRuntimeEnv(dir), AGENT_RUNNER_SYNC_BACKEND_STATE: statePath },
    async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        await client.subscribe({ channel: "run_detail", runId: run.runId }, () => {});
        await server.close();
        await sleep(350);
        assert.equal(readSyncState(statePath).resolveCalls, 0);
      } finally {
        await client.close();
      }
    },
  );
});

test("streamEvents keeps SSE subscribers active when writes report backpressure", () => {
  const req = new EventEmitter();
  const res = new FakeSseResponse([true, false]);
  let unsubscribeCount = 0;
  let publish = null;

  streamEvents(req, res, (next) => {
    publish = next;
    return () => {
      unsubscribeCount += 1;
    };
  });

  assert.equal(typeof publish, "function");
  assert.equal(
    publish({
      type: "summary_upsert",
      summary: { runId: "backpressure-run" },
    }),
    true,
  );
  assert.match(res.lastChunk, /backpressure-run/);
  assert.equal(unsubscribeCount, 0);

  req.emit("close");
  assert.equal(unsubscribeCount, 1);
});

test("daemon close aborts active runs and releases connected clients", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let aborted = false;
  const server = await serveDaemon(listenUrl, {
    async startRun({ emitEvent, abortSignal }) {
      const runId = "daemon-close-run";
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        name: "daemon close",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            aborted = true;
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                sessionAttemptCount: 1,
                totalAttemptCount: 1,
                maxAttemptsPerSession: 1,
                totalSessionCount: 1,
                tasksCompleted: 0,
                tasksTotal: 0,
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", { cliVars: {}, overrides: {} });
    assert.equal(started.runId, "daemon-close-run");
    await server.close();
    assert.equal(aborted, true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("daemon close terminates active SSE streams promptly", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl);
  const events = await openSse(httpBaseUrl, "/api/events/run-summaries");
  try {
    await Promise.race([
      (async () => {
        await server.close();
        await events.waitForClose();
      })(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for SSE shutdown")), 1000);
      }),
    ]);
  } finally {
    await events.close().catch(() => undefined);
  }
});

test("serveDaemon waits for bind errors before returning", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  try {
    await assert.rejects(() => serveDaemon(listenUrl), /EADDRINUSE|address already in use/i);
  } finally {
    await server.close();
  }
});

test("daemon returns JSON-RPC errors for malformed requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  const ws = await openRawWebSocket(listenUrl);
  try {
    ws.send("{");
    const parseError = await nextRawMessage(ws);
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "bad-request" }));
    const invalidRequest = await nextRawMessage(ws);
    assert.equal(invalidRequest.id, "bad-request");
    assert.equal(invalidRequest.error.code, -32600);
  } finally {
    ws.close();
    await server.close();
  }
});

test("daemon validates override payloads before calling shared services", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let invoked = false;
  const server = await serveDaemon(listenUrl, {
    async startRun() {
      invoked = true;
      return { runId: "unexpected" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    await assert.rejects(
      () =>
        client.call("runs.start", {
          cliVars: {},
          overrides: { bogus: "value" },
        }),
      /overrides\.bogus is not supported/,
    );
    await assert.rejects(
      () =>
        client.call("runs.start", {
          cliVars: {},
          overrides: { timeoutSec: 1.5 },
        }),
      /overrides\.timeoutSec must be a positive integer/,
    );
    await assert.rejects(
      () =>
        client.call("runs.start", {
          cliVars: {},
          overrides: { maxRetries: 1.5 },
        }),
      /overrides\.maxRetries must be a non-negative integer/,
    );
    assert.equal(invoked, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon parses and forwards cursor backend overrides", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let seenBackend;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenBackend = request.overrides.backend;
      return { runId: "daemon-cursor-backend" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", {
      cliVars: {},
      overrides: { backend: "cursor" },
    });
    assert.equal(started.runId, "daemon-cursor-backend");
    assert.equal(seenBackend, "cursor");
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon parses and forwards execution environment overrides", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let seenEnvironment;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenEnvironment = request.overrides.executionEnvironment;
      return { runId: "daemon-environment-override" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", {
      cliVars: {},
      overrides: { executionEnvironment: "feature-runtime" },
    });
    assert.equal(started.runId, "daemon-environment-override");
    assert.equal(seenEnvironment, "feature-runtime");
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon runs.start keeps callerCwd separate from overrides.cwd", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const callerCwd = "/tmp/daemon-start-caller";
  let seenCallerCwd;
  let seenOverrideCwd;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenCallerCwd = request.callerCwd;
      seenOverrideCwd = request.overrides.cwd;
      return { runId: "daemon-start-cwd" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", {
      callerCwd,
      cliVars: {},
      overrides: {},
    });
    assert.equal(started.runId, "daemon-start-cwd");
    assert.equal(seenCallerCwd, callerCwd);
    assert.equal(seenOverrideCwd, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon HTTP run start keeps callerCwd separate from overrides.cwd", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const callerCwd = "/tmp/http-start-caller";
  let seenCallerCwd;
  let seenOverrideCwd;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenCallerCwd = request.callerCwd;
      seenOverrideCwd = request.overrides.cwd;
      return { runId: "http-start-cwd" };
    },
  });
  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callerCwd,
        webVars: {},
        overrides: {},
      }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, "http-start-cwd");
    assert.equal(seenCallerCwd, callerCwd);
    assert.equal(seenOverrideCwd, undefined);
  } finally {
    await server.close();
  }
});

test("serve and --connect route CLI commands remotely and fail clearly when no daemon is available", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAgent(dir, "passive-daemon-agent", PASSIVE_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const passiveInit = await initRun(dir, "passive-daemon-agent");

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  const unavailable = runCliExpectFail(["status", "--connect", listenUrl], {
    cwd: dir,
  });
  assert.equal(unavailable.status, 3);
  assert.match(unavailable.stderr, /cannot connect to daemon/);
  assert.match(unavailable.stderr, new RegExp(`serve --listen ${listenUrl}`));

  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const agentsText = runCli(["list", "agents", "--connect", listenUrl], { cwd: dir });
    assert.match(agentsText, /daemon-agent/);

    const systemStatus = runCli(["status", "--connect", listenUrl], { cwd: dir });
    assert.match(systemStatus, /Host mode: daemon/);
    assert.match(
      systemStatus,
      new RegExp(`Connect URL: ${listenUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    assert.match(systemStatus, /Daemon: connected/);
    assert.match(
      systemStatus,
      new RegExp(`Daemon listen URL: ${listenUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );

    const systemStatusJson = JSON.parse(
      runCli(["status", "--connect", listenUrl, "--output-format", "json"], { cwd: dir }),
    );
    assert.equal(systemStatusJson.hostMode, "daemon");
    assert.equal(systemStatusJson.connectUrl, listenUrl);
    assert.deepEqual(Object.keys(systemStatusJson.daemon).sort(), [
      "daemonInstanceId",
      "listenUrl",
      "pid",
      "startedAt",
      "version",
    ]);
    assert.equal(systemStatusJson.daemon.listenUrl, listenUrl);

    const renameText = runCli(
      ["run", "set-name", init.runId, "Remote CLI name", "--connect", listenUrl],
      {
        cwd: dir,
      },
    );
    assert.match(renameText, new RegExp(`set name for run ${init.runId} to "Remote CLI name"`));

    const backendSessionText = runCli(
      ["run", "set-backend-session", passiveInit.runId, "remote-thread-7", "--connect", listenUrl],
      { cwd: dir },
    );
    assert.match(
      backendSessionText,
      new RegExp(`set backend session for run ${passiveInit.runId} to "remote-thread-7"`),
    );

    const statusViaEnv = runCli(["run", "status", init.runId], {
      cwd: dir,
      env: { AGENT_RUNNER_CONNECT: listenUrl },
    });
    assert.match(statusViaEnv, new RegExp(`── run ${init.runId} ──`));
    assert.match(statusViaEnv, /Name:\s+Remote CLI name/);

    const client = await DaemonClient.connect(listenUrl);
    try {
      const info = await client.call("daemon.info");
      assert.equal(info.listenUrl, listenUrl);
    } finally {
      await client.close();
    }
  } finally {
    await daemon.stop();
  }
});

test("daemon reconfigure surfaces support CLI and HTTP without replacing frozen codex transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-daemon-agent", CODEX_AGENT);
  writeAssignment(dir, "reconfig-work", RECONFIG_ASSIGNMENT);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const initialized = JSON.parse(
      runCli(
        [
          "init",
          "--connect",
          listenUrl,
          "--agent",
          "codex-daemon-agent",
          "--assignment",
          "reconfig-work",
          "--var",
          "target=alpha",
          "--output-format",
          "json",
        ],
        {
          cwd: dir,
          env: { AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/" },
        },
      ),
    );
    const originalManifest = readManifest(initialized.workspaceDir);
    assert.deepEqual(originalManifest.backendConfig, {
      transport: {
        type: "stdio",
      },
    });

    const cliReconfigured = JSON.parse(
      runCli(
        [
          "run",
          "reconfigure",
          initialized.runId,
          "--connect",
          listenUrl,
          "--var",
          "target=beta",
          "--output-format",
          "json",
        ],
        {
          cwd: dir,
          env: { AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4884/" },
        },
      ),
    );
    assert.equal(cliReconfigured.runId, initialized.runId);
    assert.equal(cliReconfigured.runtimeVars.target, "beta");

    const afterCliManifest = readManifest(initialized.workspaceDir);
    assert.equal(afterCliManifest.finalTasks.t1.title, "Handle beta");
    assert.deepEqual(afterCliManifest.backendConfig, {
      transport: {
        type: "stdio",
      },
    });

    const httpReconfigured = await daemonReconfigureRun(listenUrl, initialized.runId, {
      vars: { target: "gamma" },
      message: "HTTP replacement message",
    });
    assert.equal(httpReconfigured.runtimeVars.target, "gamma");
    assert.equal(httpReconfigured.message, "HTTP replacement message");

    const afterHttpManifest = readManifest(initialized.workspaceDir);
    assert.equal(afterHttpManifest.finalTasks.t1.title, "Handle gamma");
    assert.equal(afterHttpManifest.message, "HTTP replacement message");
    assert.deepEqual(afterHttpManifest.backendConfig, {
      transport: {
        type: "stdio",
      },
    });

    const rejected = await httpJson(
      deriveHttpBaseUrl(listenUrl),
      `/api/runs/${initialized.runId}/reconfigure`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vars: { target: "delta" }, backend: "codex" }),
      },
    );
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /request body\.backend is not supported/);

    const unknownVar = await httpJson(
      deriveHttpBaseUrl(listenUrl),
      `/api/runs/${initialized.runId}/reconfigure`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vars: { missing: "delta" } }),
      },
    );
    assert.equal(unknownVar.status, 400);
    assert.match(unknownVar.body.error.message, /unknown --var key\(s\): missing/);

    markRunReady(initialized.workspaceDir);
    const notInitialized = await httpJson(
      deriveHttpBaseUrl(listenUrl),
      `/api/runs/${initialized.runId}/reconfigure`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "late" }),
      },
    );
    assert.equal(notInitialized.status, 409);
    assert.match(notInitialized.body.error.message, /unless it is initialized/);
  } finally {
    await daemon.stop();
  }
});

test("connected cli can reach a daemon through --connect-host and stream attachments over the tunneled WebSocket", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const sourcePath = join(dir, "evidence.txt");
  writeFileSync(sourcePath, "ssh tunnel evidence\n");
  const fakeSsh = installFakeSsh(dir);

  const port = await freePort();
  const localPort = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/control`;
  const logicalConnectUrl = `ws://agent-runner.remote.invalid:${port}/control`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const statusJson = JSON.parse(
      runCli(
        [
          "status",
          "--connect",
          logicalConnectUrl,
          "--connect-host",
          "prod-box",
          "--connect-local-port",
          String(localPort),
          "--output-format",
          "json",
        ],
        {
          cwd: dir,
          env: fakeSshEnv(fakeSsh.binDir, {
            AGENT_RUNNER_FAKE_SSH_TARGET_HOST: "127.0.0.1",
          }),
        },
      ),
    );
    assert.equal(statusJson.hostMode, "daemon");
    assert.equal(statusJson.connectUrl, logicalConnectUrl);

    const attachmentJson = JSON.parse(
      runCli(
        [
          "attachment",
          "add",
          init.runId,
          sourcePath,
          "--connect",
          logicalConnectUrl,
          "--connect-host",
          "prod-box",
          "--connect-local-port",
          String(localPort),
          "--output-format",
          "json",
        ],
        {
          cwd: dir,
          env: fakeSshEnv(fakeSsh.binDir, {
            AGENT_RUNNER_FAKE_SSH_TARGET_HOST: "127.0.0.1",
          }),
        },
      ),
    );
    assert.equal(attachmentJson.name, "evidence.txt");

    const manifest = readManifest(init.workspaceDir);
    assert.equal(manifest.attachments.length, 1);
    assert.equal(manifest.attachments[0].name, "evidence.txt");
  } finally {
    await daemon.stop();
  }
});

test("connect-host surfaces ssh tunnel setup failures before daemon dialing", async () => {
  const dir = tempDir();
  const fakeSsh = installFakeSsh(dir);
  const port = await freePort();
  const localPort = await freePort();
  const logicalConnectUrl = `ws://agent-runner.remote.invalid:${port}/`;

  const failed = runCliExpectFail(
    [
      "status",
      "--connect",
      logicalConnectUrl,
      "--connect-host",
      "prod-box",
      "--connect-local-port",
      String(localPort),
    ],
    {
      cwd: dir,
      env: fakeSshEnv(fakeSsh.binDir, {
        AGENT_RUNNER_FAKE_SSH_MODE: "fail-auth",
      }),
    },
  );

  assert.equal(failed.status, 3);
  assert.match(
    failed.stderr,
    /agent-runner: ssh tunnel setup failed for host prod-box: Permission denied \(publickey\)\./,
  );
  assert.doesNotMatch(failed.stderr, /cannot connect to daemon/);
});

test("connect-host reports local port collisions before websocket dialing", async () => {
  const dir = tempDir();
  const fakeSsh = installFakeSsh(dir);
  const port = await freePort();
  const localPort = await freePort();
  const logicalConnectUrl = `ws://agent-runner.remote.invalid:${port}/`;
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(localPort, "127.0.0.1", resolve));

  try {
    const failed = runCliExpectFail(
      [
        "status",
        "--connect",
        logicalConnectUrl,
        "--connect-host",
        "prod-box",
        "--connect-local-port",
        String(localPort),
      ],
      {
        cwd: dir,
        env: fakeSshEnv(fakeSsh.binDir, {
          AGENT_RUNNER_FAKE_SSH_TARGET_HOST: "127.0.0.1",
        }),
      },
    );

    assert.equal(failed.status, 3);
    assert.match(
      failed.stderr,
      /agent-runner: ssh tunnel setup failed for host prod-box: bind \[127\.0\.0\.1\]:\d+: Address already in use/,
    );
    assert.doesNotMatch(failed.stderr, /cannot connect to daemon/);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("serve rejects connect-host tunnel flags", async () => {
  const dir = tempDir();
  const failedHost = runCliExpectFail(["serve", "--connect-host", "prod-box"], { cwd: dir });
  assert.equal(failedHost.status, 3);
  assert.match(failedHost.stderr, /agent-runner: serve does not accept --connect-host/);

  const failedLocalPort = runCliExpectFail(["serve", "--connect-local-port", "5773"], { cwd: dir });
  assert.equal(failedLocalPort.status, 3);
  assert.match(failedLocalPort.stderr, /agent-runner: serve does not accept --connect-local-port/);
});

test("serve exposes HTTP/SSE alongside the existing WebSocket RPC transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const client = await DaemonClient.connect(listenUrl);
    try {
      const info = await client.call("daemon.info");
      assert.equal(info.listenUrl, listenUrl);
    } finally {
      await client.close();
    }

    const status = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.run.runId, init.runId);

    const events = await openSse(httpBaseUrl, "/api/events/run-summaries");
    await events.close();
  } finally {
    await daemon.stop();
  }
});

test("serve fails before binding when daemon auth is enabled without a token", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  await withEnv(
    {
      AGENT_RUNNER_DAEMON_AUTH_ENABLED: "true",
      AGENT_RUNNER_DAEMON_TOKEN: "",
    },
    async () => {
      await assert.rejects(
        () => serveDaemon(listenUrl),
        (error) =>
          error instanceof Error &&
          error.message.includes("AGENT_RUNNER_DAEMON_TOKEN") &&
          !error.message.includes("secret-value"),
      );
    },
  );

  const server = await serveDaemon(listenUrl);
  await server.close();
});

test("daemon bearer auth protects HTTP, SSE, and WebSocket while leaving public web routes open", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const token = "daemon-auth-secret";
  const authHeaders = { authorization: `Bearer ${token}` };

  await withSeededFrontendDist(async ({ assetPath }) => {
    await withEnv(
      {
        ...sharedRuntimeEnv(dir),
        AGENT_RUNNER_DAEMON_AUTH_ENABLED: "yes",
        AGENT_RUNNER_DAEMON_TOKEN: `  ${token}  `,
      },
      async () => {
        const server = await serveDaemon(listenUrl);
        try {
          for (const [label, headers] of [
            ["missing", undefined],
            ["malformed", { authorization: "Bearer" }],
            ["unsupported", { authorization: token }],
            ["wrong", { authorization: "Bearer wrong-secret" }],
          ]) {
            const response = await httpJson(httpBaseUrl, "/api/daemon", { headers });
            assert.equal(response.status, 401, label);
            assert.deepEqual(response.body, {
              error: {
                code: "UNAUTHENTICATED",
                message: "daemon authentication required",
              },
            });
            assert.equal(response.headers.get("www-authenticate"), null);
            assert.doesNotMatch(JSON.stringify(response.body), /wrong-secret/);
          }

          const authorized = await httpJson(httpBaseUrl, "/api/daemon", {
            headers: authHeaders,
          });
          assert.equal(authorized.status, 200);
          assert.equal(authorized.body.daemon.listenUrl, listenUrl);

          const appConfig = await httpJson(httpBaseUrl, "/app-config.json");
          assert.equal(appConfig.status, 200);
          assert.equal(appConfig.body.webBasePath, "/");
          assert.equal(appConfig.headers.get("www-authenticate"), null);

          const staticAsset = await fetch(
            new URL(`/assets/${assetPath.split("/").at(-1)}`, httpBaseUrl),
          );
          assert.equal(staticAsset.status, 200);
          assert.equal(staticAsset.headers.get("www-authenticate"), null);

          for (const path of [
            "/api/events/run-summaries",
            `/api/runs/${init.runId}/events/detail`,
            `/api/runs/${init.runId}/events/audit`,
            `/api/runs/${init.runId}/events/timeline`,
          ]) {
            const response = await fetch(new URL(path, httpBaseUrl));
            const text = await response.text();
            assert.equal(response.status, 401, path);
            assert.match(response.headers.get("content-type") ?? "", /application\/json/);
            assert.doesNotMatch(text, /data:/);
            assert.deepEqual(JSON.parse(text), {
              error: {
                code: "UNAUTHENTICATED",
                message: "daemon authentication required",
              },
            });
          }

          const events = await openSse(httpBaseUrl, "/api/events/run-summaries", {
            headers: authHeaders,
          });
          await events.close();

          await assert.rejects(
            () => openRawWebSocket(listenUrl),
            /Unexpected server response: 401|socket hang up/,
          );
          await assert.rejects(
            () =>
              openRawWebSocket(listenUrl, {
                headers: { authorization: "Bearer wrong-secret" },
              }),
            /Unexpected server response: 401|socket hang up/,
          );

          const client = await DaemonClient.connect(listenUrl, { headers: authHeaders });
          try {
            const info = await client.call("daemon.info");
            assert.equal(info.listenUrl, listenUrl);
          } finally {
            await client.close();
          }
        } finally {
          await server.close();
        }
      },
    );
  });
});

test("connected CLI reports daemon auth failures with token guidance", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const token = "daemon-auth-secret";
  const daemon = await startCliDaemon(dir, listenUrl, {
    env: {
      AGENT_RUNNER_DAEMON_AUTH_ENABLED: "true",
      AGENT_RUNNER_DAEMON_TOKEN: token,
    },
  });
  try {
    const missingTokenCli = runCliExpectFail(["status", "--connect", listenUrl], {
      cwd: dir,
      env: { AGENT_RUNNER_DAEMON_TOKEN: "" },
    });
    assert.equal(missingTokenCli.status, 3);
    assert.match(missingTokenCli.stderr, /set AGENT_RUNNER_DAEMON_TOKEN/);
    assert.doesNotMatch(missingTokenCli.stderr, /serve --listen/);
    assert.doesNotMatch(missingTokenCli.stderr, new RegExp(token));
  } finally {
    await daemon.stop();
  }
});

test("daemon direct HTTP helpers send bearer auth when configured", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const token = "direct-helper-secret";
  const authHeaders = { authorization: `Bearer ${token}` };

  await withEnv(
    {
      ...sharedRuntimeEnv(dir),
      AGENT_RUNNER_DAEMON_AUTH_ENABLED: "true",
      AGENT_RUNNER_DAEMON_TOKEN: token,
    },
    async () => {
      const server = await serveDaemon(listenUrl);
      try {
        await assert.rejects(
          () => daemonGetRunAuditHistory(listenUrl, init.runId),
          /daemon authentication required/,
        );

        const history = await daemonGetRunAuditHistory(listenUrl, init.runId, { authHeaders });
        assert.equal(history.runId, init.runId);

        const reconfigured = await daemonReconfigureRun(
          listenUrl,
          init.runId,
          { message: "updated message" },
          { authHeaders },
        );
        assert.equal(reconfigured.runId, init.runId);
      } finally {
        await server.close();
      }
    },
  );
});

test("serve exits cleanly on SIGTERM", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const result = await daemon.stop("SIGTERM");
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  } finally {
    // no-op if already stopped
  }
});

test("serve exits 130 on SIGINT", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const result = await daemon.stop("SIGINT");
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
  } finally {
    // no-op if already stopped
  }
});

test("daemon HTTP init uses the remote caller cwd when the agent omits cwd", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  try {
    const run = await httpJson(httpBaseUrl, "/api/runs/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: join(daemonDir, "agents", "daemon-agent", "agent.md"),
        assignment: join(daemonDir, "assignments", "daemon-work", "assignment.md"),
        callerCwd: clientDir,
        webVars: {},
        overrides: {},
      }),
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.run.cwd, clientDir);
  } finally {
    await daemon.stop();
  }
});

test("daemon HTTP supports a browser definition-to-init flow with explicit callerCwd", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  try {
    const agentDefinition = await httpJson(httpBaseUrl, "/api/agents/daemon-agent");
    assert.equal(agentDefinition.status, 200);
    assert.equal(agentDefinition.body.agent.config.name, "daemon-agent");

    const run = await httpJson(httpBaseUrl, "/api/runs/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: agentDefinition.body.agent.config.name,
        assignment: "daemon-work",
        callerCwd: clientDir,
        webVars: {},
        overrides: {},
      }),
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.run.agent.name, "daemon-agent");
    assert.equal(run.body.run.assignment?.name, "daemon-work");
    assert.equal(run.body.run.cwd, clientDir);
  } finally {
    await daemon.stop();
  }
});

test("daemon HTTP init rejects removed backendSpecific overrides", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const response = await httpJson(httpBaseUrl, "/api/runs/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webVars: {},
        overrides: {
          backendSpecific: {
            codex: {
              transport: {
                type: "stdio",
              },
            },
          },
        },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.match(response.body.error.message, /overrides\.backendSpecific is not supported/);
  } finally {
    await daemon.stop();
  }
});

test("daemon HTTP init rejects malformed launcher overrides", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const response = await httpJson(httpBaseUrl, "/api/runs/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webVars: {},
        overrides: {
          launcher: 42,
        },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.match(response.body.error.message, /overrides\.launcher/);
  } finally {
    await daemon.stop();
  }
});

test("daemon init uses the remote caller cwd when the agent omits cwd", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  try {
    const output = runCli(
      [
        "init",
        "--connect",
        listenUrl,
        "--agent",
        join(daemonDir, "agents", "daemon-agent", "agent.md"),
        "--assignment",
        join(daemonDir, "assignments", "daemon-work", "assignment.md"),
        "--output-format",
        "json",
      ],
      { cwd: clientDir },
    );
    const run = JSON.parse(output);
    assert.equal(run.cwd, clientDir);
    assert.equal(run.execution.hostMode, "daemon");
    assert.equal(run.execution.controller.kind, "daemon");
    assert.match(
      run.execution.controller.daemonInstanceId,
      new RegExp(`^daemon-${daemon.child.pid}-[0-9a-z]+$`),
    );
  } finally {
    await daemon.stop();
  }
});

test("daemon RPC start rejects removed backendSpecific overrides", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  const client = await DaemonClient.connect(listenUrl);
  try {
    await assert.rejects(
      client.call("runs.start", {
        cliVars: {},
        overrides: {
          backendSpecific: {
            codex: {
              transport: {
                type: "stdio",
              },
            },
          },
        },
      }),
      (err) => {
        assert.ok(err instanceof DaemonRpcError);
        assert.match(err.message, /overrides\.backendSpecific is not supported/);
        return true;
      },
    );
  } finally {
    await client.close();
    await daemon.stop();
  }
});

test("daemon rpc exposes launcher definitions and resolves named launcher overrides on the daemon host", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  writeLauncher(
    daemonDir,
    "ssh-wrap",
    `schemaVersion: 1
name: ssh-wrap
command: ssh
args: [prod, --]
`,
  );
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  const client = await DaemonClient.connect(listenUrl);
  try {
    const launchers = await client.call("launchers.list", {});
    assert.deepEqual(
      launchers.launchers.entries.map((entry) => entry.name),
      ["direct", "ssh-wrap"],
    );
    assert.deepEqual(launchers.launchers.warnings, []);

    const launcher = await client.call("launchers.get", { target: "ssh-wrap" });
    assert.equal(launcher.launcher.definition.name, "ssh-wrap");
    assert.equal(launcher.launcher.definition.kind, "prefix");

    const started = await client.call("runs.start", {
      agent: join(daemonDir, "agents", "daemon-agent", "agent.md"),
      assignment: join(daemonDir, "assignments", "daemon-work", "assignment.md"),
      callerCwd: clientDir,
      cliVars: {},
      overrides: {
        launcher: "ssh-wrap",
      },
    });
    const run = await client.call("runs.get", { target: started.runId });
    const manifest = readManifest(run.run.workspaceDir);
    assert.deepEqual(manifest.launcher, {
      name: "ssh-wrap",
      kind: "prefix",
      source: "named",
      command: "ssh",
      args: ["prod", "--"],
    });
  } finally {
    await client.close();
    await daemon.stop();
  }
});

test("daemon rpc exposes task definitions without overloading run task RPCs", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  const taskPath = writeTask(
    daemonDir,
    "review/architecture",
    `---
schemaVersion: 1
title: Architecture review
---
Review module boundaries.
`,
  );
  const init = await initRun(daemonDir);
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  const client = await DaemonClient.connect(listenUrl);
  try {
    const taskDefinitions = await client.call("taskDefinitions.list", {});
    assert.deepEqual(taskDefinitions.taskDefinitions, {
      kind: "task",
      entries: [{ name: "review/architecture", path: taskPath, root: "config" }],
      warnings: [],
    });

    const taskDefinition = await client.call("taskDefinitions.get", {
      target: "review/architecture",
    });
    assert.deepEqual(taskDefinition.taskDefinition, {
      kind: "task",
      task: {
        id: "review/architecture",
        title: "Architecture review",
        body: "Review module boundaries.",
        hooks: [],
      },
      sourcePath: taskPath,
    });

    const connectedList = runCli(["list", "tasks", "--connect", listenUrl], { cwd: clientDir });
    assert.equal(connectedList, "  review/architecture\n");

    const connectedShow = runCli(["show", "task", "review/architecture", "--connect", listenUrl], {
      cwd: clientDir,
    });
    assert.match(connectedShow, /Task: review\/architecture/);
    assert.match(connectedShow, /title:\s+Architecture review/);
    assert.match(connectedShow, /Review module boundaries\./);

    const runTasks = await client.call("tasks.list", { target: init.runId });
    assert.deepEqual(
      runTasks.tasks.map((task) => task.id),
      ["t1"],
    );
    assert.equal("taskDefinitions" in runTasks, false);

    const runTask = await client.call("tasks.get", { target: init.runId, taskId: "t1" });
    assert.equal(runTask.task.id, "t1");
    assert.equal(runTask.task.status, "pending");
    assert.equal("sourcePath" in runTask.task, false);
  } finally {
    await client.close();
    await daemon.stop();
  }
});

test("daemon classifies definition lookup and config errors as command errors across WS and HTTP", async () => {
  const daemonDir = tempDir();
  writeLauncher(
    daemonDir,
    "bad-name",
    `schemaVersion: 1
name: other-name
command: ssh
`,
  );
  writeTask(
    daemonDir,
    "review/bad",
    `---
schemaVersion: 1
id: review/wrong
title: Bad task
---
Bad body.
`,
  );

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  const client = await DaemonClient.connect(listenUrl);
  try {
    await assert.rejects(
      () => client.call("launchers.get", { target: "missing-launcher" }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.code === -32003 &&
        /Launcher not found: missing-launcher/.test(err.message),
    );
    await assert.rejects(
      () => client.call("taskDefinitions.get", { target: "missing-task" }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.code === -32003 &&
        /Task not found: missing-task/.test(err.message),
    );

    const targetedInvalidPath = encodeURIComponent("./launchers/bad-name.yaml");
    const targetedInvalidTaskPath = encodeURIComponent("./tasks/review/bad.md");
    await assert.rejects(
      () =>
        client.call("launchers.get", {
          target: "./launchers/bad-name.yaml",
          cwd: daemonDir,
        }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.code === -32003 &&
        /must match canonical id/.test(err.message),
    );
    await assert.rejects(
      () =>
        client.call("taskDefinitions.get", {
          target: "./tasks/review/bad.md",
          cwd: daemonDir,
        }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.code === -32003 &&
        /must match canonical id/.test(err.message),
    );

    const invalidLauncherHttp = await httpJson(
      httpBaseUrl,
      `/api/launchers/${targetedInvalidPath}?cwd=${encodeURIComponent(daemonDir)}`,
    );
    const invalidTaskHttp = await httpJson(
      httpBaseUrl,
      `/api/task-definitions/${targetedInvalidTaskPath}?cwd=${encodeURIComponent(daemonDir)}`,
    );
    assert.equal(invalidLauncherHttp.status, 422);
    assert.equal(invalidTaskHttp.status, 422);
    assert.equal(invalidLauncherHttp.body.error.code, "INVALID_COMMAND");
    assert.equal(invalidTaskHttp.body.error.code, "INVALID_COMMAND");
    assert.match(invalidLauncherHttp.body.error.message, /must match canonical id/);
    assert.match(invalidTaskHttp.body.error.message, /must match canonical id/);
  } finally {
    await client.close();
    await daemon.stop();
  }
});

test("daemon HTTP exposes definition routes with WS parity and direct-path support", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  writeTask(
    daemonDir,
    "review/architecture",
    `---
schemaVersion: 1
title: Architecture review
---
Review module boundaries.
`,
  );
  writeLauncher(
    daemonDir,
    "ssh-wrap",
    `schemaVersion: 1
name: ssh-wrap
command: ssh
args: [prod, --]
`,
  );

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  const client = await DaemonClient.connect(listenUrl);
  try {
    const agentListHttp = await httpJson(httpBaseUrl, "/api/agents");
    const assignmentListHttp = await httpJson(httpBaseUrl, "/api/assignments");
    const launcherListHttp = await httpJson(httpBaseUrl, "/api/launchers");
    const taskListHttp = await httpJson(httpBaseUrl, "/api/task-definitions");
    assert.equal(agentListHttp.status, 200);
    assert.equal(assignmentListHttp.status, 200);
    assert.equal(launcherListHttp.status, 200);
    assert.equal(taskListHttp.status, 200);
    assert.deepEqual(agentListHttp.body, await client.call("agents.list"));
    assert.deepEqual(assignmentListHttp.body, await client.call("assignments.list"));
    assert.deepEqual(launcherListHttp.body, await client.call("launchers.list"));
    assert.deepEqual(taskListHttp.body, await client.call("taskDefinitions.list"));

    const agentDetailHttp = await httpJson(httpBaseUrl, "/api/agents/daemon-agent");
    const assignmentDetailHttp = await httpJson(httpBaseUrl, "/api/assignments/daemon-work");
    const launcherDetailHttp = await httpJson(httpBaseUrl, "/api/launchers/ssh-wrap");
    const taskDetailHttp = await httpJson(
      httpBaseUrl,
      "/api/task-definitions/review%2Farchitecture",
    );
    assert.equal(agentDetailHttp.status, 200);
    assert.equal(assignmentDetailHttp.status, 200);
    assert.equal(launcherDetailHttp.status, 200);
    assert.equal(taskDetailHttp.status, 200);
    assert.deepEqual(
      agentDetailHttp.body,
      await client.call("agents.get", { target: "daemon-agent" }),
    );
    assert.deepEqual(
      assignmentDetailHttp.body,
      await client.call("assignments.get", { target: "daemon-work" }),
    );
    assert.deepEqual(
      launcherDetailHttp.body,
      await client.call("launchers.get", { target: "ssh-wrap" }),
    );
    assert.deepEqual(
      taskDetailHttp.body,
      await client.call("taskDefinitions.get", { target: "review/architecture" }),
    );

    const agentTarget = encodeURIComponent("./agents/daemon-agent/agent.md");
    const assignmentTarget = encodeURIComponent("./assignments/daemon-work/assignment.md");
    const launcherTarget = encodeURIComponent("./launchers/ssh-wrap.yaml");
    const taskTarget = encodeURIComponent("./tasks/review/architecture.md");
    const cwdQuery = `cwd=${encodeURIComponent(daemonDir)}`;

    const directAgent = await httpJson(httpBaseUrl, `/api/agents/${agentTarget}?${cwdQuery}`);
    const directAssignment = await httpJson(
      httpBaseUrl,
      `/api/assignments/${assignmentTarget}?${cwdQuery}`,
    );
    const directLauncher = await httpJson(
      httpBaseUrl,
      `/api/launchers/${launcherTarget}?${cwdQuery}`,
    );
    const directTask = await httpJson(
      httpBaseUrl,
      `/api/task-definitions/${taskTarget}?${cwdQuery}`,
    );
    assert.equal(directAgent.status, 200);
    assert.equal(directAssignment.status, 200);
    assert.equal(directLauncher.status, 200);
    assert.equal(directTask.status, 200);
    assert.deepEqual(directAgent.body, agentDetailHttp.body);
    assert.deepEqual(directAssignment.body, assignmentDetailHttp.body);
    assert.deepEqual(directLauncher.body, launcherDetailHttp.body);
    assert.deepEqual(directTask.body, taskDetailHttp.body);

    const missingAgent = await httpJson(httpBaseUrl, "/api/agents/missing-agent");
    const missingAssignment = await httpJson(httpBaseUrl, "/api/assignments/missing-assignment");
    const missingLauncher = await httpJson(httpBaseUrl, "/api/launchers/missing-launcher");
    const missingTask = await httpJson(httpBaseUrl, "/api/task-definitions/missing-task");
    assert.equal(missingAgent.status, 404);
    assert.equal(missingAssignment.status, 404);
    assert.equal(missingLauncher.status, 404);
    assert.equal(missingTask.status, 404);
    assert.equal(missingAgent.body.error.code, "NOT_FOUND");
    assert.equal(missingAssignment.body.error.code, "NOT_FOUND");
    assert.equal(missingLauncher.body.error.code, "NOT_FOUND");
    assert.equal(missingTask.body.error.code, "NOT_FOUND");

    for (const path of [
      "/api/agents/%E0%A4%A",
      "/api/assignments/%E0%A4%A",
      "/api/launchers/%E0%A4%A",
      "/api/task-definitions/%E0%A4%A",
    ]) {
      const response = await httpJson(httpBaseUrl, path);
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "INVALID_REQUEST");
      assert.match(response.body.error.message, /valid percent-encoded text/);
    }
  } finally {
    await client.close();
    await daemon.stop();
  }
});

test("daemon HTTP exposes the run input surface route with validation and direct-path support", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(
    daemonDir,
    "new-run-work",
    `---
schemaVersion: 1
name: new-run-work
cwd: packages/core
message: Ship the resolver-backed UI.
maxRetries: 2
vars:
  plan:
    type: string
    description: Short feature brief.
    required: true
    sources: [cli, web]
tasks:
  - id: t1
    title: First
---
New run work.
`,
  );

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  try {
    const success = await httpJson(
      httpBaseUrl,
      "/api/run-input-surface?agent=daemon-agent&assignment=new-run-work",
    );
    assert.equal(success.status, 200);
    assert.deepEqual(
      success.body.inputSurface.runSettings.map((field) => field.key),
      [
        "cwd",
        "backend",
        "launcher",
        "model",
        "effort",
        "message",
        "name",
        "timeoutSec",
        "unrestricted",
        "maxRetries",
      ],
    );
    assert.equal(success.body.inputSurface.runSettings[0].section, "context");
    assert.equal(success.body.inputSurface.runSettings[1].section, "execution");
    assert.equal(success.body.inputSurface.assignmentInputs[0].key, "plan");
    assert.equal(success.body.inputSurface.assignmentInputs[0].section, "task");
    assert.equal(success.body.inputSurface.assignmentInputs[0].required, true);
    assert.equal(success.body.inputSurface.assignmentInputs[0].value, null);

    const directAgent = encodeURIComponent("./agents/daemon-agent/agent.md");
    const directAssignment = encodeURIComponent("./assignments/new-run-work/assignment.md");
    const directPath = await httpJson(
      httpBaseUrl,
      `/api/run-input-surface?agent=${directAgent}&assignment=${directAssignment}&cwd=${encodeURIComponent(daemonDir)}`,
    );
    assert.equal(directPath.status, 200);
    assert.deepEqual(directPath.body, success.body);

    const missingAgent = await httpJson(
      httpBaseUrl,
      "/api/run-input-surface?assignment=new-run-work",
    );
    const emptyAssignment = await httpJson(
      httpBaseUrl,
      "/api/run-input-surface?agent=daemon-agent&assignment=",
    );
    const malformed = await httpJson(
      httpBaseUrl,
      "/api/run-input-surface?agent=daemon-agent&assignment=%E0%A4%A",
    );
    assert.equal(missingAgent.status, 400);
    assert.equal(emptyAssignment.status, 400);
    assert.equal(malformed.status, 400);
    assert.equal(missingAgent.body.error.code, "INVALID_REQUEST");
    assert.equal(emptyAssignment.body.error.code, "INVALID_REQUEST");
    assert.equal(malformed.body.error.code, "INVALID_REQUEST");

    const unknownAgent = await httpJson(
      httpBaseUrl,
      "/api/run-input-surface?agent=missing-agent&assignment=new-run-work",
    );
    const unknownAssignment = await httpJson(
      httpBaseUrl,
      "/api/run-input-surface?agent=daemon-agent&assignment=missing-work",
    );
    assert.equal(unknownAgent.status, 404);
    assert.equal(unknownAssignment.status, 404);
    assert.equal(unknownAgent.body.error.code, "NOT_FOUND");
    assert.equal(unknownAssignment.body.error.code, "NOT_FOUND");
  } finally {
    await daemon.stop();
  }
});

test("daemon-target CLI forwards init --message-file content as the daemon message override", async () => {
  const dir = tempDir();
  const message = "daemon init message\nwith exact spacing\n";
  const messagePath = join(dir, "init-message.txt");
  writeFileSync(messagePath, message);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.init") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              run: {
                runId: "init-run",
              },
            },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "init",
        "--connect",
        listenUrl,
        "--agent",
        "daemon-agent",
        "--message-file",
        messagePath,
        "--output-format",
        "json",
      ],
      { cwd: dir },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(requests[0].method, "runs.init");
    assert.equal(requests[0].params.overrides.message, message);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon-target CLI forwards positional init message as the daemon message override", async () => {
  const dir = tempDir();
  const message = "inline daemon message";
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.init") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              run: {
                runId: "init-run",
              },
            },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "init",
        "--connect",
        listenUrl,
        "--agent",
        "daemon-agent",
        "--output-format",
        "json",
        message,
      ],
      { cwd: dir },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(requests[0].method, "runs.init");
    assert.equal(requests[0].params.overrides.message, message);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon-target CLI forwards fresh run --message-file content as the daemon message override", async () => {
  const dir = tempDir();
  const message = "daemon start message\nwith exact spacing";
  const messagePath = join(dir, "start-message.txt");
  writeFileSync(messagePath, message);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.start") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "message-file-start-run" },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--agent",
        "daemon-agent",
        "--assignment",
        "daemon-work",
        "--message-file",
        messagePath,
      ],
      { cwd: dir },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(requests[0].method, "runs.start");
    assert.equal(requests[0].params.overrides.message, message);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon-target CLI detaches fresh runs without subscribing for events", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.start") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "detached-start-run" },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--detach",
      "--agent",
      "daemon-agent",
      "--assignment",
      "daemon-work",
    ]);
    assert.deepEqual(
      { code: result.code, signal: result.signal, stderr: result.stderr },
      { code: 0, signal: null, stderr: "" },
    );
    assert.equal(
      result.stdout,
      "agent-runner: detached run detached-start-run\n" +
        'Resume later with: agent-runner run --resume-run detached-start-run "..."\n' +
        "Check status with: agent-runner run status detached-start-run\n",
    );
    assert.deepEqual(
      requests.map((request) => request.method),
      ["runs.start"],
    );
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not forward local AGENT_RUNNER_CODEX_WS_URL on start requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: "detached-start-run" },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--agent",
        "daemon-agent",
        "--assignment",
        "daemon-work",
      ],
      {
        env: {
          AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.overrides.backendConfig, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards --parent-run as structured start parentRunId and notification intent", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: "detached-start-run" },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--detach",
      "--agent",
      "daemon-agent",
      "--parent-run",
      "parent-123",
      "--no-inherit-run-group",
    ]);
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.parentRunId, "parent-123");
    assert.equal(requests[0].params.noInheritRunGroup, true);
    assert.deepEqual(requests[0].params.parentCompletionNotification, {
      source: "detached_invocation",
      parentRunId: "parent-123",
    });
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not send parent notification intent for attached runs", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  const runId = "attached-start-run";
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.start") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId },
          }),
        );
        return;
      }
      if (request.method === "events.subscribe") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { subscriptionId: "sub-1" },
          }),
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "run.timeline",
            params: {
              subscriptionId: "sub-1",
              runId,
              cursor: 1,
              event: {
                type: "run_finished",
                summary: {
                  runId,
                  status: "success",
                  sessionAttemptCount: 1,
                  totalAttemptCount: 1,
                  maxAttemptsPerSession: 1,
                  totalSessionCount: 1,
                  tasksCompleted: 1,
                  tasksTotal: 1,
                  tasks: [],
                },
              },
            },
          }),
        );
        return;
      }
      if (request.method === "runs.get") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { run: { runId } },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {},
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--agent",
      "daemon-agent",
      "--parent-run",
      "parent-123",
    ]);
    assert.equal(result.code, 0);
    const startRequest = requests.find((request) => request.method === "runs.start");
    assert.equal(startRequest.params.parentRunId, "parent-123");
    assert.equal(startRequest.params.parentCompletionNotification, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI honors detached parent notification opt-out", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: "detached-start-run" },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--detach",
      "--agent",
      "daemon-agent",
      "--parent-run",
      "parent-123",
      "--no-notify-parent-on-complete",
    ]);
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.parentRunId, "parent-123");
    assert.equal(requests[0].params.parentCompletionNotification, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI detaches resume runs and supports json output", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.resume") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "detached-resume-run" },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--detach",
      "--resume-run",
      "abc123",
      "--output-format",
      "json",
    ]);
    assert.deepEqual(
      { code: result.code, signal: result.signal, stderr: result.stderr },
      { code: 0, signal: null, stderr: "" },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      runId: "detached-resume-run",
      detached: true,
    });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["runs.resume"],
    );
    assert.equal(requests[0].params.target, "abc123");
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not forward local Codex transport env on resume requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: "detached-resume-run" },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--resume-run",
        "abc123",
        "--output-format",
        "json",
      ],
      {
        env: {
          AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.overrides.backendConfig, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards parent notification intent but not lineage on resume requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: "detached-resume-run" },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--resume-run",
        "abc123",
        "--output-format",
        "json",
      ],
      {
        env: {
          AGENT_RUNNER_PARENT_RUN_ID: "parent-123",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.parentRunId, undefined);
    assert.deepEqual(requests[0].params.parentCompletionNotification, {
      source: "detached_invocation",
      parentRunId: "parent-123",
    });
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not forward local AGENT_RUNNER_CODEX_WS_URL on init requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            run: {
              runId: "init-run",
            },
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      ["init", "--connect", listenUrl, "--agent", "daemon-agent", "--output-format", "json"],
      {
        env: {
          AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.overrides.backendConfig, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not forward local AGENT_RUNNER_CODEX_UDS_PATH on run/init/resume requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.init") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              run: {
                runId: "init-run",
              },
            },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: `${request.method}-run` },
        }),
      );
    });
  });

  try {
    const env = {
      AGENT_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock",
    };
    const start = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--agent",
        "daemon-agent",
        "--assignment",
        "daemon-work",
      ],
      { env },
    );
    const resume = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--resume-run",
        "abc123",
        "--output-format",
        "json",
      ],
      { env },
    );
    const init = await runCliAsync(
      ["init", "--connect", listenUrl, "--agent", "daemon-agent", "--output-format", "json"],
      { env },
    );

    assert.equal(start.code, 0);
    assert.equal(resume.code, 0);
    assert.equal(init.code, 0);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["runs.start", "runs.resume", "runs.init"],
    );
    assert.equal(requests[0].params.overrides.backendConfig, undefined);
    assert.equal(requests[1].params.overrides.backendConfig, undefined);
    assert.equal(requests[2].params.overrides.backendConfig, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not forward conflicting local Codex transport env", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { runId: "unexpected-run" },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      [
        "run",
        "--connect",
        listenUrl,
        "--detach",
        "--agent",
        "daemon-agent",
        "--assignment",
        "daemon-work",
      ],
      {
        env: {
          AGENT_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock",
          AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(requests[0].params.overrides.backendConfig, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards local AGENT_RUNNER_PARENT_RUN_ID as structured init parentRunId", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            run: {
              runId: "init-run",
            },
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync(
      ["init", "--connect", listenUrl, "--agent", "daemon-agent", "--output-format", "json"],
      {
        env: {
          AGENT_RUNNER_PARENT_RUN_ID: "parent-123",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.parentRunId, "parent-123");
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI rejects --detach without daemon mode", () => {
  const failure = runCliExpectFail(["run", "--detach"]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.match(
    failure.stderr,
    /--detach requires daemon-connected run execution \(\-\-connect or AGENT_RUNNER_CONNECT\)/,
  );
});

test("daemon-target CLI rejects init --detach", () => {
  const failure = runCliExpectFail(["init", "--detach"]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /init does not accept --detach/);
});

test("daemon-target CLI rejects --detach on grouped run subcommands", () => {
  const failure = runCliExpectFail(["run", "reset", "abc123", "--detach"]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.match(
    failure.stderr,
    /run reset only supports <id-or-path>, --connect, and --output-format/,
  );
  assert.match(failure.stderr, /--detach/);
});

test("daemon-target CLI rejects --no-notify-parent-on-complete outside plain detached run", () => {
  const expected =
    "agent-runner: --no-notify-parent-on-complete is only valid with `run --detach`\n";
  for (const args of [
    ["init", "--no-notify-parent-on-complete"],
    ["run", "status", "abc123", "--no-notify-parent-on-complete"],
    ["run", "--agent", "daemon-agent", "--no-notify-parent-on-complete"],
    ["run", "--detach", "--no-notify-parent-on-complete"],
  ]) {
    const failure = runCliExpectFail(args);
    assert.equal(failure.status, 3);
    assert.equal(failure.stdout, "");
    assert.equal(failure.stderr, expected);
  }
});

test("daemon-target CLI rejects explicit group with no-inherit run group", () => {
  const failure = runCliExpectFail([
    "run",
    "--agent",
    "daemon-agent",
    "--group-id",
    "explicit-group",
    "--no-inherit-run-group",
  ]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.equal(
    failure.stderr,
    "agent-runner: --group-id cannot be combined with --no-inherit-run-group\n",
  );
});

test("daemon-target CLI surfaces Ctrl+C cancel failures instead of exiting as a clean interrupt", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const subscriptionId = "sub-1";
  let startHandled = false;

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      if (request.method === "runs.start") {
        startHandled = true;
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "daemon-cli-run" },
          }),
        );
        return;
      }
      if (request.method === "events.subscribe") {
        assert.equal(request.params.channel, "run_timeline");
        assert.equal(request.params.runId, "daemon-cli-run");
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { subscriptionId },
          }),
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "run.timeline",
            params: {
              subscriptionId,
              runId: "daemon-cli-run",
              event: {
                type: "run_started",
                runId: "daemon-cli-run",
                agentName: "daemon-agent",
                assignmentSourcePath: null,
                name: "daemon cli",
                cwd: process.cwd(),
                sessionIndex: 1,
              },
            },
          }),
        );
        return;
      }
      if (request.method === "runs.abort") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32004,
              message: "cancel failed",
            },
          }),
        );
        return;
      }
      if (request.method === "events.unsubscribe") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { unsubscribed: true },
          }),
        );
        return;
      }
    });
  });

  const child = spawn(
    "node",
    [
      CLI_PATH,
      "run",
      "--connect",
      listenUrl,
      "--agent",
      "daemon-agent",
      "--assignment",
      "daemon-work",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        if (startHandled) {
          resolve(undefined);
          return;
        }
        if (Date.now() - startedAt > 5_000) {
          reject(new Error("CLI did not start the daemon-target run in time"));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });

    child.kill("SIGINT");
    const result = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(stderr, /Ctrl\+C cancel request failed: cancel failed/);
    assert.doesNotMatch(stderr, /interrupted by user/i);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI force-exits on a second Ctrl+C while daemon cancel is still pending", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const subscriptionId = "sub-1";
  let startHandled = false;

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      if (request.method === "runs.start") {
        startHandled = true;
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "daemon-cli-run" },
          }),
        );
        return;
      }
      if (request.method === "events.subscribe") {
        assert.equal(request.params.channel, "run_timeline");
        assert.equal(request.params.runId, "daemon-cli-run");
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { subscriptionId },
          }),
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "run.timeline",
            params: {
              subscriptionId,
              runId: "daemon-cli-run",
              event: {
                type: "run_started",
                runId: "daemon-cli-run",
                agentName: "daemon-agent",
                assignmentSourcePath: null,
                name: "daemon cli",
                cwd: process.cwd(),
                sessionIndex: 1,
              },
            },
          }),
        );
        return;
      }
      if (request.method === "runs.abort") {
        return;
      }
      if (request.method === "events.unsubscribe") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { unsubscribed: true },
          }),
        );
      }
    });
  });

  const child = spawn(
    "node",
    [
      CLI_PATH,
      "run",
      "--connect",
      listenUrl,
      "--agent",
      "daemon-agent",
      "--assignment",
      "daemon-work",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        if (startHandled) {
          resolve(undefined);
          return;
        }
        if (Date.now() - startedAt > 5_000) {
          reject(new Error("CLI did not start the daemon-target run in time"));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });

    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGINT");
    const result = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(result, { code: 130, signal: null });
    assert.match(stderr, /requesting daemon cancel/);
    assert.match(stderr, /forced exit/);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});
