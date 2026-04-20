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
import { serveDaemon } from "../apps/cli/dist/daemon/server.js";
import { streamEvents } from "../apps/cli/dist/daemon/sse.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
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

async function initRun(baseDir, agentName = "daemon-agent") {
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
        canResume: true,
        canAbort: false,
        abortReason: "not_active_in_daemon",
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

      const dependency = await initRun(dir);
      const addedDependency = await client.call("runs.addDependency", {
        target: init.runId,
        dependencyRunId: dependency.runId,
      });
      assert.deepEqual(addedDependency.result, {
        runId: init.runId,
        dependencyRunIds: [dependency.runId],
        changed: true,
      });

      const removedDependency = await client.call("runs.removeDependency", {
        target: init.runId,
        dependencyRunId: dependency.runId,
      });
      assert.deepEqual(removedDependency.result, {
        runId: init.runId,
        dependencyRunIds: [],
        changed: true,
      });

      const clearedDependencies = await client.call("runs.clearDependencies", {
        target: init.runId,
      });
      assert.deepEqual(clearedDependencies.result, {
        runId: init.runId,
        dependencyRunIds: [],
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
      `${first.runId} [initialized] name=<unnamed> 0/1 repo=unknown agent=daemon-agent assignment=daemon-work`,
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

      const detail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.assignment.name, "daemon-work");
      assert.equal(detail.body.run.name, null);
      assert.equal(detail.body.run.status, "initialized");
      assert.equal(detail.body.run.effectiveStatus, "initialized");
      assert.deepEqual(detail.body.run.dependencies, []);
      assert.deepEqual(detail.body.run.dependents, []);
      assert.deepEqual(detail.body.run.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(detail.body.run.capabilities.canAbort, false);
      assert.equal(detail.body.run.capabilities.abortReason, "not_active_in_daemon");

      const dependency = await initRun(dir);
      const addedDependency = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dependencyRunId: dependency.runId }),
      });
      assert.equal(addedDependency.status, 200);
      assert.deepEqual(addedDependency.body.result, {
        runId: init.runId,
        dependencyRunIds: [dependency.runId],
        changed: true,
      });

      const removedDependency = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies/${dependency.runId}`,
        {
          method: "DELETE",
        },
      );
      assert.equal(removedDependency.status, 200);
      assert.deepEqual(removedDependency.body.result, {
        runId: init.runId,
        dependencyRunIds: [],
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
        dependencyRunIds: [],
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

test("daemon attachment HTTP routes scope cwd listings and reject invalid cwdScope query values", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const target = await initRun(dir);
  const peer = await initRun(dir);
  const different = await initRun(dir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  patchManifest(different.workspaceDir, (manifest) => {
    manifest.cwd = join(dir, "other-cwd");
  });

  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      for (const [runId, name] of [
        [target.runId, "target.txt"],
        [peer.runId, "peer.txt"],
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

      const scoped = await httpJson(
        httpBaseUrl,
        `/api/runs/${target.runId}/attachments?cwdScope=true`,
      );
      assert.equal(scoped.status, 200);
      assert.deepEqual(
        new Set(scoped.body.attachments.map((attachment) => attachment.ownerRunId)),
        new Set([target.runId, peer.runId]),
      );
      assert.equal(
        scoped.body.attachments.some((attachment) => attachment.ownerRunId === different.runId),
        false,
      );

      const unscoped = await httpJson(
        httpBaseUrl,
        `/api/runs/${target.runId}/attachments?cwdScope=false`,
      );
      assert.equal(unscoped.status, 200);
      assert.deepEqual(
        unscoped.body.attachments.map((attachment) => attachment.ownerRunId),
        [target.runId],
      );

      const invalid = await httpJson(
        httpBaseUrl,
        `/api/runs/${target.runId}/attachments?cwdScope=maybe`,
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_REQUEST");
      assert.match(invalid.body.error.message, /cwdScope must be "true" or "false"/);
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
        cliVars: {
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
    const response = await httpJson(httpBaseUrl, "/api/runs/..%2F..%2Fetc/tasks");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "NOT_FOUND");
    assert.equal(response.body.error.message, "resource not found");
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
          dependencyRunId: "../other-run",
        }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.message === "dependencyRunId must be a run id, not a path",
    );

    const response = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencyRunId: "../other-run" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.equal(response.body.error.message, "dependencyRunId must be a run id, not a path");
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment-seed.md",
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
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        name: "Daemon-owned run",
        cwd: "/tmp/fake",
        sessionIndex: 1,
      });
      emitEvent({ type: "attempt_started", attempt: 1 });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                attempts: 1,
                maxAttempts: 1,
                tasksCompleted: 0,
                tasksTotal: 1,
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment-seed.md",
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
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
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
                attempts: 1,
                maxAttempts: 1,
                tasksCompleted: 0,
                tasksTotal: 1,
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
      body: JSON.stringify({ cliVars: {}, overrides: {} }),
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
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
        attempts: 0,
        maxAttempts: 1,
        sessionCount: 0,
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
            attempt: null,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment-seed.md",
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
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
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
        attempts: 1,
        maxAttempts: 1,
        tasksCompleted: 0,
        tasksTotal: 0,
        assignmentPath: "/tmp/fake/assignment-seed.md",
        tasks: [],
        runId,
      };
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        assignmentPath: summary.assignmentPath,
        name: "daemon test",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({ type: "attempt_started", attempt: 1 });
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
    const started = await clientA.call("runs.start", { cliVars: {}, overrides: {} });
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment-seed.md",
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
        attempts: status === "success" ? 2 : 1,
        maxAttempts: 2,
        sessionCount: 1,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        name: "daemon retrying test",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({
        type: "attempt_started",
        attempt: 1,
        sessionIndex: 0,
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
          attempts: 2,
          maxAttempts: 2,
          tasksCompleted: 2,
          tasksTotal: 2,
          assignmentPath: "/tmp/fake/assignment-seed.md",
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
      body: JSON.stringify({ cliVars: {}, overrides: {} }),
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
    manifest.dependencyRunIds = [source.runId];
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
      'channel must be one of "run_summary", "run_detail", or "run_timeline"',
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment-seed.md",
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
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        name: "daemon sse",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({
        type: "attempt_started",
        attempt: 1,
        sessionIndex: 0,
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
                attempts: 1,
                maxAttempts: 1,
                tasksCompleted: 0,
                tasksTotal: 0,
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
      body: JSON.stringify({ cliVars: {}, overrides: {} }),
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
        attempt: 1,
        sessionIndex: 0,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment-seed.md",
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
        attempts: 1,
        maxAttempts: 3,
        sessionCount: 1,
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
        name: "daemon timeline history",
        cwd: process.cwd(),
        sessionIndex: 1,
      });
      emitEvent({
        type: "attempt_started",
        attempt: 2,
        sessionIndex: 1,
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
                attempts: 2,
                maxAttempts: 3,
                tasksCompleted: 1,
                tasksTotal: 1,
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
    body: JSON.stringify({ cliVars: {}, overrides: {} }),
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
        assignmentPath: "/tmp/fake/assignment-seed.md",
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
                attempts: 1,
                maxAttempts: 1,
                tasksCompleted: 0,
                tasksTotal: 0,
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
        cliVars: {},
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
        cliVars: {},
        overrides: {},
      }),
    });
    assert.equal(run.status, 200);
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
        cliVars: {},
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
        cliVars: {},
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

test("daemon-target CLI forwards local TASK_RUNNER_CODEX_WS_URL as a structured resume override", async () => {
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
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
                assignmentPath: "/tmp/fake/assignment-seed.md",
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
