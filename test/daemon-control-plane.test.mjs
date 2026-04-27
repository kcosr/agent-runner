import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { DaemonClient, DaemonRpcError } from "../apps/cli/dist/daemon/client.js";
import { deriveHttpBaseUrl } from "../apps/cli/dist/daemon/config.js";
import { daemonReconfigureRun } from "../apps/cli/dist/daemon/http-client.js";
import { serveDaemon } from "../apps/cli/dist/daemon/server.js";
import { streamEvents } from "../apps/cli/dist/daemon/sse.js";
import { getRun as getRunDetail } from "../packages/core/dist/app/service.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { ResumeError } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withTaskStateLock } from "../packages/core/dist/core/run/workspace-state.js";
import { sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);
const CLI_WEB_ROOT = resolvePath(new URL("../apps/cli/dist/web", import.meta.url).pathname);

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
  return mkdtempSync(join(tmpdir(), "task-runner-daemon-"));
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

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
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
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
        "    <title>task-runner</title>",
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

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate a test port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function openRawWebSocket(listenUrl) {
  const ws = new WebSocket(listenUrl);
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

async function httpJson(baseUrl, path, opts = {}) {
  const response = await fetch(new URL(path, baseUrl), opts);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

async function openSse(baseUrl, path) {
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

async function startCliDaemon(baseDir, listenUrl) {
  const child = spawn("node", [CLI_PATH, "serve", "--listen", listenUrl], {
    cwd: baseDir,
    env: { ...process.env, ...sharedRuntimeEnv(baseDir) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  await new Promise((resolve, reject) => {
    const onExit = (code, signal) =>
      reject(new Error(`daemon exited before ready (code=${code} signal=${signal})`));
    child.once("exit", onExit);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("serving on")) {
        child.off("exit", onExit);
        resolve();
      }
    });
  });

  return {
    child,
    async stop(signal = "SIGINT") {
      child.kill(signal);
      return await new Promise((resolve) =>
        child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })),
      );
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForValue(read, description) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await sleep(20);
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
const mode = process.env.TASK_RUNNER_FAKE_SSH_MODE ?? "proxy";
const logPath = process.env.TASK_RUNNER_FAKE_SSH_LOG;
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
const targetHost = process.env.TASK_RUNNER_FAKE_SSH_TARGET_HOST ?? targetHostRaw;
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
      assert.match(info.daemonInstanceId, /^daemon-/);

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
        changed: true,
      });

      const removedDependency = await client.call("runs.removeDependency", {
        target: init.runId,
        dependency: { type: "run", runId: dependency.runId },
      });
      assert.deepEqual(removedDependency.result, {
        runId: init.runId,
        dependencies: [],
        changed: true,
      });

      const clearedDependencies = await client.call("runs.clearDependencies", {
        target: init.runId,
      });
      assert.deepEqual(clearedDependencies.result, {
        runId: init.runId,
        dependencies: [],
        changed: false,
      });

      const renamed = await client.call("runs.setName", {
        target: init.runId,
        name: "RPC renamed run",
      });
      assert.deepEqual(renamed.result, {
        runId: init.runId,
        name: "RPC renamed run",
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
        changed: true,
      });

      const noted = await client.call("runs.setNote", {
        target: init.runId,
        note: "RPC note for the shared editor",
      });
      assert.deepEqual(noted.result, {
        runId: init.runId,
        note: "RPC note for the shared editor",
        changed: true,
      });

      const pinned = await client.call("runs.setPinned", {
        target: init.runId,
        pinned: true,
      });
      assert.deepEqual(pinned.result, {
        runId: init.runId,
        pinned: true,
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
        changed: true,
      });

      const clearedBackendSession = await client.call("runs.clearBackendSession", {
        target: passiveInit.runId,
      });
      assert.deepEqual(clearedBackendSession.result, {
        runId: passiveInit.runId,
        backendSessionId: null,
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

      const assignment = await client.call("assignments.get", { target: "daemon-work", cwd: dir });
      assert.equal(assignment.assignment.config.name, "daemon-work");
    } finally {
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

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const daemon = await httpJson(httpBaseUrl, "/api/daemon");
      assert.equal(daemon.status, 200);
      assert.equal(daemon.body.daemon.listenUrl, listenUrl);
      assert.match(daemon.body.daemon.daemonInstanceId, /^daemon-/);

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
          "x-task-runner-attachment-name": "evidence.txt",
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
      assert.equal(content.headers.get("x-task-runner-attachment-id"), attachmentId);
      assert.equal(content.headers.get("x-task-runner-sha256"), uploadedBody.attachment.sha256);
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
          "x-task-runner-attachment-name": "overflow.txt",
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
            "x-task-runner-attachment-name": name,
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
          apiBasePath: "/api",
          runSummaryEventsPath: "/api/events/run-summaries",
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
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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

test("daemon HTTP projections preserve hook summary and detail fields", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-hook-projection";

  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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
        repo: "task-runner",
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
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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
        assert.equal(target, dependent.runId);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        resolveAutoStarted();
        return { runId: target };
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
        assert.equal(target, dependent.runId);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        return { runId: target };
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
      assert.deepEqual(resumeTargets, [dependent.runId]);
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
        if (target === source.runId) {
          markRunRunning(source.workspaceDir);
          emitRunStarted(emitEvent, target, dir);
          markRunSuccessful(source.workspaceDir);
          emitRunFinished(emitEvent, target);
          return { runId: target };
        }

        assert.equal(target, dependent.runId);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        return { runId: target };
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
      assert.deepEqual(resumeTargets, [source.runId, dependent.runId]);
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
        assert.equal(target, dependent.runId);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        resolveAutoStarted();
        return { runId: target };
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
        assert.equal(target, dependent.runId);
        resolveFirstCall();
        await new Promise((resolve) => {
          releaseAutoStart = resolve;
        });
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        return { runId: target };
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
        assert.equal(target, dependent.runId);
        resolveFirstCall();
        await new Promise((resolve) => {
          releaseAutoStart = resolve;
        });
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        return { runId: target };
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
        assert.equal(target, dependent.runId);
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
        assert.equal(target, dependent.runId);
        markRunRunning(dependent.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        resolveRetryStarted();
        return { runId: target };
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
      TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.runId);
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.status = "running";
            manifest.schedule = null;
          });
          emitRunStarted(emitEvent, target, dir);
          resolveStarted();
          return { runId: target };
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
      TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.runId);
          resolveScheduledStart();
          await new Promise((resolve) => {
            releaseScheduledStart = resolve;
          });
          markRunRunning(run.workspaceDir);
          emitRunStarted(emitEvent, target, dir);
          return { runId: target };
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
      TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
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
      TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, overrides, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.runId);
          assert.equal(overrides.message, "Resuming after scheduled delay.");
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.status = "running";
            manifest.endedAt = null;
            manifest.exitCode = null;
            manifest.schedule = null;
          });
          emitRunStarted(emitEvent, target, dir);
          resolveStarted();
          return { runId: target };
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
      TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
    },
    async () => {
      const server = await serveDaemon(listenUrl, {
        async resumeRun({ target, overrides, emitEvent }) {
          resumeCalls += 1;
          assert.equal(target, run.runId);
          assert.equal(overrides.message, "Resuming after scheduled delay.");
          patchManifest(run.workspaceDir, (manifest) => {
            manifest.status = "running";
            manifest.endedAt = null;
            manifest.exitCode = null;
          });
          emitRunStarted(emitEvent, target, dir);
          resolveStarted();
          return { runId: target };
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
        if (target === source.runId) {
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
          emitRunStarted(emitEvent, target, dir);
          return { runId: target };
        }

        assert.equal(target, cloneRunId);
        patchManifest(cloneWorkspaceDir, (manifest) => {
          manifest.status = "running";
          manifest.schedule = null;
        });
        emitRunStarted(emitEvent, target, dir);
        resolveCloneStarted();
        return { runId: target };
      },
    });
    const client = await DaemonClient.connect(listenUrl);
    try {
      await client.call("runs.resume", { target: source.runId, overrides: {} });
      await cloneStarted;
      const running = await waitForRunStatus(httpBaseUrl, cloneRunId, "running");
      assert.equal(running.runId, cloneRunId);
      assert.equal(running.schedule, null);
      assert.deepEqual(resumeTargets, [source.runId, cloneRunId]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon defers run.created projection until task-state lock is released", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const run = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  await withEnv(sharedRuntimeEnv(dir), async () => {
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
  });
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
        assert.equal(target, run.runId);
        markRunRunning(run.workspaceDir);
        emitRunStarted(emitEvent, target, dir);
        resolveStarted();
        await release;
        return { runId: target };
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
      TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC: "120",
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
    "manifest at /tmp/stale/run.json has schemaVersion 13; this version of task-runner requires schemaVersion 14",
  );

  const server = await serveDaemon(listenUrl, {
    updateRunNote(target, input) {
      return {
        runId: target,
        note: input.note,
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
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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
        repo: "task-runner",
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
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
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
      env: { TASK_RUNNER_CONNECT: listenUrl },
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
          env: { TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/" },
        },
      ),
    );
    const originalManifest = readManifest(initialized.workspaceDir);
    assert.deepEqual(originalManifest.backendSpecific, {
      codex: {
        transport: {
          type: "ws",
          url: "ws://127.0.0.1:4773/",
        },
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
          env: { TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4884/" },
        },
      ),
    );
    assert.equal(cliReconfigured.runId, initialized.runId);
    assert.equal(cliReconfigured.runtimeVars.target, "beta");

    const afterCliManifest = readManifest(initialized.workspaceDir);
    assert.equal(afterCliManifest.finalTasks.t1.title, "Handle beta");
    assert.equal(afterCliManifest.backendSpecific.codex.transport.url, "ws://127.0.0.1:4773/");

    const httpReconfigured = await daemonReconfigureRun(listenUrl, initialized.runId, {
      vars: { target: "gamma" },
      message: "HTTP replacement message",
    });
    assert.equal(httpReconfigured.runtimeVars.target, "gamma");
    assert.equal(httpReconfigured.message, "HTTP replacement message");

    const afterHttpManifest = readManifest(initialized.workspaceDir);
    assert.equal(afterHttpManifest.finalTasks.t1.title, "Handle gamma");
    assert.equal(afterHttpManifest.message, "HTTP replacement message");
    assert.equal(afterHttpManifest.backendSpecific.codex.transport.url, "ws://127.0.0.1:4773/");

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

test("connected cli can reach a daemon through --connect-host and reuse the same connect context for attachment HTTP", async () => {
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
  const logicalConnectUrl = `ws://task-runner.remote.invalid:${port}/control`;
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
            TASK_RUNNER_FAKE_SSH_TARGET_HOST: "127.0.0.1",
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
            TASK_RUNNER_FAKE_SSH_TARGET_HOST: "127.0.0.1",
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
  const logicalConnectUrl = `ws://task-runner.remote.invalid:${port}/`;

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
        TASK_RUNNER_FAKE_SSH_MODE: "fail-auth",
      }),
    },
  );

  assert.equal(failed.status, 3);
  assert.match(
    failed.stderr,
    /task-runner: ssh tunnel setup failed for host prod-box: Permission denied \(publickey\)\./,
  );
  assert.doesNotMatch(failed.stderr, /cannot connect to daemon/);
});

test("connect-host reports local port collisions before websocket dialing", async () => {
  const dir = tempDir();
  const fakeSsh = installFakeSsh(dir);
  const port = await freePort();
  const localPort = await freePort();
  const logicalConnectUrl = `ws://task-runner.remote.invalid:${port}/`;
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
          TASK_RUNNER_FAKE_SSH_TARGET_HOST: "127.0.0.1",
        }),
      },
    );

    assert.equal(failed.status, 3);
    assert.match(
      failed.stderr,
      /task-runner: ssh tunnel setup failed for host prod-box: bind \[127\.0\.0\.1\]:\d+: Address already in use/,
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
  assert.match(failedHost.stderr, /task-runner: serve does not accept --connect-host/);

  const failedLocalPort = runCliExpectFail(["serve", "--connect-local-port", "5773"], { cwd: dir });
  assert.equal(failedLocalPort.status, 3);
  assert.match(failedLocalPort.stderr, /task-runner: serve does not accept --connect-local-port/);
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

test("daemon HTTP init rejects malformed backendSpecific codex transport overrides", async () => {
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
                type: "ws",
                url: "https://example.com/not-ws",
                extra: true,
              },
            },
          },
        },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.match(response.body.error.message, /overrides\.backendSpecific\.codex\.transport/);
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
    assert.match(run.execution.controller.daemonInstanceId, /^daemon-/);
  } finally {
    await daemon.stop();
  }
});

test("daemon RPC start rejects malformed backendSpecific codex transport overrides", async () => {
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
                url: "ws://127.0.0.1:4773/",
              },
            },
          },
        },
      }),
      (err) => {
        assert.ok(err instanceof DaemonRpcError);
        assert.match(
          err.message,
          /overrides\.backendSpecific\.codex\.transport\.url is not supported/,
        );
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

test("daemon classifies launcher lookup and config errors as command errors across WS and HTTP", async () => {
  const daemonDir = tempDir();
  writeLauncher(
    daemonDir,
    "bad-name",
    `schemaVersion: 1
name: other-name
command: ssh
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

    const targetedInvalidPath = encodeURIComponent("./launchers/bad-name.yaml");
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

    const invalidLauncherHttp = await httpJson(
      httpBaseUrl,
      `/api/launchers/${targetedInvalidPath}?cwd=${encodeURIComponent(daemonDir)}`,
    );
    assert.equal(invalidLauncherHttp.status, 422);
    assert.equal(invalidLauncherHttp.body.error.code, "INVALID_COMMAND");
    assert.match(invalidLauncherHttp.body.error.message, /must match canonical id/);
  } finally {
    await client.close();
    await daemon.stop();
  }
});

test("daemon HTTP exposes definition routes with WS parity and direct-path support", async () => {
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

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  const client = await DaemonClient.connect(listenUrl);
  try {
    const agentListHttp = await httpJson(httpBaseUrl, "/api/agents");
    const assignmentListHttp = await httpJson(httpBaseUrl, "/api/assignments");
    const launcherListHttp = await httpJson(httpBaseUrl, "/api/launchers");
    assert.equal(agentListHttp.status, 200);
    assert.equal(assignmentListHttp.status, 200);
    assert.equal(launcherListHttp.status, 200);
    assert.deepEqual(agentListHttp.body, await client.call("agents.list"));
    assert.deepEqual(assignmentListHttp.body, await client.call("assignments.list"));
    assert.deepEqual(launcherListHttp.body, await client.call("launchers.list"));

    const agentDetailHttp = await httpJson(httpBaseUrl, "/api/agents/daemon-agent");
    const assignmentDetailHttp = await httpJson(httpBaseUrl, "/api/assignments/daemon-work");
    const launcherDetailHttp = await httpJson(httpBaseUrl, "/api/launchers/ssh-wrap");
    assert.equal(agentDetailHttp.status, 200);
    assert.equal(assignmentDetailHttp.status, 200);
    assert.equal(launcherDetailHttp.status, 200);
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

    const agentTarget = encodeURIComponent("./agents/daemon-agent/agent.md");
    const assignmentTarget = encodeURIComponent("./assignments/daemon-work/assignment.md");
    const launcherTarget = encodeURIComponent("./launchers/ssh-wrap.yaml");
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
    assert.equal(directAgent.status, 200);
    assert.equal(directAssignment.status, 200);
    assert.equal(directLauncher.status, 200);
    assert.deepEqual(directAgent.body, agentDetailHttp.body);
    assert.deepEqual(directAssignment.body, assignmentDetailHttp.body);
    assert.deepEqual(directLauncher.body, launcherDetailHttp.body);

    const missingAgent = await httpJson(httpBaseUrl, "/api/agents/missing-agent");
    const missingAssignment = await httpJson(httpBaseUrl, "/api/assignments/missing-assignment");
    const missingLauncher = await httpJson(httpBaseUrl, "/api/launchers/missing-launcher");
    assert.equal(missingAgent.status, 404);
    assert.equal(missingAssignment.status, 404);
    assert.equal(missingLauncher.status, 404);
    assert.equal(missingAgent.body.error.code, "NOT_FOUND");
    assert.equal(missingAssignment.body.error.code, "NOT_FOUND");
    assert.equal(missingLauncher.body.error.code, "NOT_FOUND");

    for (const path of [
      "/api/agents/%E0%A4%A",
      "/api/assignments/%E0%A4%A",
      "/api/launchers/%E0%A4%A",
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
      "task-runner: detached run detached-start-run\n" +
        'Resume later with: task-runner run --resume-run detached-start-run "..."\n' +
        "Check status with: task-runner run status detached-start-run\n",
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

test("daemon-target CLI forwards local TASK_RUNNER_CODEX_WS_URL as a structured start override", async () => {
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
          TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(requests[0].params.overrides.backendSpecific, {
      codex: {
        transport: {
          type: "ws",
          url: "ws://127.0.0.1:4773/",
        },
      },
    });
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards --parent-run as structured start parentRunId", async () => {
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
    ]);
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.parentRunId, "parent-123");
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
          TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.overrides.backendSpecific, undefined);
    assert.equal(requests[0].params.overrides.codexTransportEnv, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI does not forward TASK_RUNNER_PARENT_RUN_ID on resume requests", async () => {
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
          TASK_RUNNER_PARENT_RUN_ID: "parent-123",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(requests[0].params.parentRunId, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards local TASK_RUNNER_CODEX_WS_URL as a structured init override", async () => {
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
          TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(requests[0].params.overrides.backendSpecific, {
      codex: {
        transport: {
          type: "ws",
          url: "ws://127.0.0.1:4773/",
        },
      },
    });
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards local TASK_RUNNER_CODEX_UDS_PATH as structured run/init overrides", async () => {
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
      TASK_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock",
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
    for (const request of [requests[0], requests[2]]) {
      assert.deepEqual(request.params.overrides.backendSpecific, {
        codex: {
          transport: {
            type: "uds",
            path: "/tmp/codex.sock",
          },
        },
      });
    }
    assert.equal(requests[1].params.overrides.backendSpecific, undefined);
    assert.equal(requests[1].params.overrides.codexTransportEnv, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards conflicting local Codex transport env for daemon-side precedence resolution", async () => {
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
          TASK_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock",
          TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(requests[0].params.overrides.codexTransportEnv, {
      udsPath: "/tmp/codex.sock",
      wsUrl: "ws://127.0.0.1:4773/",
    });
    assert.equal(requests[0].params.overrides.backendSpecific, undefined);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI forwards local TASK_RUNNER_PARENT_RUN_ID as structured init parentRunId", async () => {
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
          TASK_RUNNER_PARENT_RUN_ID: "parent-123",
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
    /--detach requires daemon-connected run execution \(\-\-connect or TASK_RUNNER_CONNECT\)/,
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
