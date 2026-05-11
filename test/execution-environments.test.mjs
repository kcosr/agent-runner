import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildEnvironmentLauncher,
  prepareExecutionEnvironment,
  resolveFreshExecutionEnvironment,
} from "../packages/core/dist/core/run/execution-environments.js";
import { withEnv, withRuntimeRoots } from "./helpers/runtime-paths.mjs";

function writeEnvironment(baseDir, name, body) {
  const path = join(baseDir, "environments", `${name}.yaml`);
  mkdirSync(join(baseDir, "environments"), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function explicitWorkspaceLifecycleStatePath(stateDir, workspacePath) {
  return join(
    stateDir,
    "workspace-state",
    createHash("sha256").update(resolve(workspacePath)).digest("hex"),
  );
}

test("resolveFreshExecutionEnvironment loads named config and interpolates run variables", () =>
  withRuntimeRoots("task-runner-environment-", ({ rootDir, configDir }) => {
    writeEnvironment(
      configDir,
      "managed-dev",
      `schemaVersion: 1
kind: container
mode: managed
engine: podman
cwd: /workspace/{{repo}}
env:
  TARGET: "{{target}}"
image: node:22
containerName: task-runner-{{run_id}}
mounts:
  - hostPath: "{{host_path}}"
    containerPath: /workspace/demo
    mode: rw
extraExecArgs: [--user, coder]
network: none
security:
  readOnlyRootFilesystem: true
  capDrop: [ALL]
extraRunArgs: [--pull, never]
cleanup:
  policy: manual
`,
    );

    const environment = resolveFreshExecutionEnvironment({
      reference: { kind: "name", ref: "managed-dev", name: "managed-dev" },
      cwd: rootDir,
      injectedVars: {
        repo: "demo",
        target: "test",
        host_path: rootDir,
        run_id: "run-123",
      },
      runId: "fallback-run",
      runGroupId: "group-123",
      backend: "claude",
    });

    assert.deepEqual(environment, {
      kind: "container",
      mode: "managed",
      name: "managed-dev",
      sourcePath: join(configDir, "environments", "managed-dev.yaml"),
      engine: "podman",
      cwd: "/workspace/demo",
      env: {
        TARGET: "test",
      },
      extraExecArgs: ["--user", "coder"],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: null,
      lifecycle: null,
      sessionMounts: [],
      mounts: [
        {
          hostPath: rootDir,
          containerPath: "/workspace/demo",
          mode: "rw",
        },
      ],
      network: "none",
      security: {
        readOnlyRootFilesystem: true,
        capDrop: ["ALL"],
        capAdd: [],
      },
      extraRunArgs: ["--pull", "never"],
      cleanup: {
        policy: "manual",
        cleanedAt: null,
        lastError: null,
      },
    });
  }));

test("resolveFreshExecutionEnvironment uses an override environment before the agent reference", () =>
  withRuntimeRoots("task-runner-environment-", ({ rootDir, configDir }) => {
    writeEnvironment(
      configDir,
      "agent-dev",
      `schemaVersion: 1
kind: container
mode: existing
cwd: /agent
container: agent-box
`,
    );
    writeEnvironment(
      configDir,
      "override-dev",
      `schemaVersion: 1
kind: container
mode: existing
cwd: /override
container: override-box
`,
    );

    const environment = resolveFreshExecutionEnvironment({
      reference: { kind: "name", ref: "agent-dev", name: "agent-dev" },
      overrideEnvironment: "override-dev",
      cwd: rootDir,
      injectedVars: {},
      runId: "run-123",
      runGroupId: "group-123",
      backend: "claude",
    });

    assert.equal(environment.mode, "existing");
    assert.equal(environment.name, "override-dev");
    assert.equal(environment.cwd, "/override");
    assert.equal(environment.container, "override-box");
  }));

test("buildEnvironmentLauncher wraps backend commands in a container exec launcher", () => {
  const environment = {
    kind: "container",
    mode: "existing",
    name: "dev",
    sourcePath: "/config/environments/dev.yaml",
    engine: "docker",
    cwd: "/workspace",
    env: {
      FOO: "from-environment",
      ONLY_ENVIRONMENT: "yes",
    },
    extraExecArgs: ["--user", "coder"],
    lastValidatedAt: "2026-05-05T12:00:00.000Z",
    lastError: null,
    container: "devbox",
    containerIdAtValidation: "sha256:abc",
    expectedMounts: [],
  };

  assert.deepEqual(
    buildEnvironmentLauncher(environment, {
      FOO: "from-backend",
      BAR: "baz",
      TASK_RUNNER_RUN_ID: "run-123",
    }),
    {
      kind: "prefix",
      command: "docker",
      args: [
        "exec",
        "-i",
        "--user",
        "coder",
        "-w",
        "/workspace",
        "-e",
        "TASK_RUNNER_RUN_ID=run-123",
        "-e",
        "FOO=from-environment",
        "-e",
        "ONLY_ENVIRONMENT=yes",
        "devbox",
      ],
      name: null,
      source: "inline",
    },
  );
});

test("resolveFreshExecutionEnvironment resolves group-scoped workspace mounts and rewrites cwd", () =>
  withRuntimeRoots("task-runner-environment-", ({ rootDir, configDir, stateDir }) => {
    writeEnvironment(
      configDir,
      "workspace-dev",
      `schemaVersion: 1
kind: container
mode: managed
engine: docker
cwd: "{{workspace_host_path}}/repo"
image: node:22
lifetime: group
workspace:
  scope: group
  hostRoot: "{{state_dir}}/group-workspaces"
  containerPath: /workspace
  mode: rw
lifecycle:
  onWorkspaceCreate:
    - kind: command
      target: container
      command: sh
      args: ["-lc", "echo {{workspace_container_path}} {{target}}"]
      env:
        WORKSPACE_HOST: "{{workspace_host_path}}"
`,
    );

    const environment = resolveFreshExecutionEnvironment({
      reference: { kind: "name", ref: "workspace-dev", name: "workspace-dev" },
      cwd: rootDir,
      injectedVars: {
        cwd: join(stateDir, "group-workspaces", "group-123"),
        state_dir: stateDir,
        target: "ready",
      },
      runId: "run-123",
      runGroupId: "group-123",
      backend: "claude",
    });

    assert.equal(environment.mode, "managed");
    assert.equal(environment.lifetime, "group");
    assert.equal(environment.containerName, "task-runner-group-123");
    assert.equal(environment.cwd, "/workspace/repo");
    assert.deepEqual(environment.workspace, {
      scope: "group",
      hostRoot: join(stateDir, "group-workspaces"),
      hostPath: join(stateDir, "group-workspaces", "group-123"),
      containerPath: "/workspace",
      mode: "rw",
      create: true,
      createdAt: null,
    });
    assert.deepEqual(environment.lifecycle, {
      afterStart: null,
      onWorkspaceCreate: {
        steps: [
          {
            kind: "command",
            target: "container",
            command: "sh",
            args: ["-lc", "echo /workspace ready"],
            env: {
              WORKSPACE_HOST: join(stateDir, "group-workspaces", "group-123"),
            },
            cwd: null,
            timeoutMs: null,
            user: null,
            detach: false,
          },
        ],
        completedAt: null,
        lastError: null,
      },
    });
    assert.deepEqual(environment.sessionMounts, []);
  }));

test("resolveFreshExecutionEnvironment expands backend session mount presets", () =>
  withRuntimeRoots("task-runner-environment-", ({ rootDir, configDir }) => {
    const homeDir = join(rootDir, "home");
    writeEnvironment(
      configDir,
      "codex-dev",
      `schemaVersion: 1
kind: container
mode: managed
engine: docker
cwd: /workspace
image: node:22
sessionMounts: backend
`,
    );

    withEnv({ HOME: homeDir }, () => {
      const environment = resolveFreshExecutionEnvironment({
        reference: { kind: "name", ref: "codex-dev", name: "codex-dev" },
        cwd: rootDir,
        injectedVars: {},
        runId: "run-123",
        runGroupId: "group-123",
        backend: "codex",
      });

      assert.equal(environment.mode, "managed");
      assert.deepEqual(environment.sessionMounts, [
        {
          preset: "codex",
          hostPath: join(homeDir, ".codex", "sessions"),
          containerPath: join(homeDir, ".codex", "sessions"),
          mode: "rw",
        },
      ]);
    });
  }));

test("prepareExecutionEnvironment creates workspace host directory and mounts it", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
    const codexSessionsPath = join(rootDir, "home", ".codex", "sessions");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd, target] = process.argv.slice(2);
if (cmd === "inspect") {
  if (target === "task-runner-group-123") process.exit(1);
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "group",
      containerName: "task-runner-group-123",
      containerId: null,
      workspace: {
        scope: "group",
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
        lifecycle: null,
      },
      sessionMounts: [
        {
          preset: "codex",
          hostPath: codexSessionsPath,
          containerPath: codexSessionsPath,
          mode: "rw",
        },
      ],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const prepared = await withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment(environment),
    );

    assert.equal(prepared.containerId, "container-123");
    assert.ok(existsSync(workspacePath));
    assert.ok(existsSync(codexSessionsPath));
    assert.equal(typeof prepared.workspace.createdAt, "string");
    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(commands[1].slice(0, 10), [
      "run",
      "-d",
      "--name",
      "task-runner-group-123",
      "--label",
      "task-runner=true",
      "--label",
      "task-runner-environment=workspace-dev",
      "--workdir",
      "/workspace",
    ]);
    assert.ok(commands[1].includes(`${workspacePath}:/workspace:rw`));
    assert.ok(commands[1].includes(`${codexSessionsPath}:${codexSessionsPath}:rw`));
    assert.deepEqual(commands.at(-1), ["exec", "container-123", "test", "-d", "/workspace"]);
  }));

test("prepareExecutionEnvironment runs workspace lifecycle once before cwd validation", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir, stateDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspaceRoot = join(rootDir, "workspaces");
    const workspacePath = join(workspaceRoot, "run-123");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd, target] = process.argv.slice(2);
if (cmd === "inspect") {
  if (target === "task-runner-run-123") process.exit(1);
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace/repo",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: {
        scope: "run",
        hostRoot: workspaceRoot,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
      },
      lifecycle: {
        afterStart: null,
        onWorkspaceCreate: {
          steps: [
            {
              kind: "git-clone",
              target: "container",
              source: "/source",
              baseRef: "origin/main",
              branch: "feature/test",
              timeoutMs: null,
            },
            {
              kind: "command",
              target: "container",
              command: "npm",
              args: ["install"],
              env: {
                CI: "1",
              },
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedAt: null,
          lastError: null,
        },
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const prepared = await withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment(environment),
    );
    const lifecycleCompletedAt = prepared.lifecycle.onWorkspaceCreate.completedAt;
    assert.equal(typeof lifecycleCompletedAt, "string");
    assert.ok(
      existsSync(
        join(stateDir, "workspace-state", "run-123", ".task-runner-workspace-lifecycle.json"),
      ),
    );

    await withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
      prepareExecutionEnvironment(prepared),
    );

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const lifecycleCommands = commands.filter(
      (command) =>
        command[0] === "exec" &&
        (command.includes("git") || command.includes("npm")) &&
        !command.includes("test"),
    );
    assert.deepEqual(lifecycleCommands, [
      [
        "exec",
        "-i",
        "-w",
        "/workspace",
        "container-123",
        "git",
        "-c",
        "protocol.ext.allow=never",
        "clone",
        "--",
        "/source",
        ".",
      ],
      [
        "exec",
        "-i",
        "-w",
        "/workspace",
        "container-123",
        "git",
        "checkout",
        "-B",
        "feature/test",
        "origin/main",
      ],
      ["exec", "-i", "-w", "/workspace", "-e", "CI=1", "container-123", "npm", "install"],
    ]);
    assert.deepEqual(commands.at(-1), ["exec", "container-123", "test", "-d", "/workspace/repo"]);
  }));

test("prepareExecutionEnvironment runs targeted lifecycle phases with metadata and cwd defaults", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const hostLogPath = join(rootDir, "host.log");
    const workspacePath = join(rootDir, "workspace");
    const hostStepPath = join(rootDir, "host-step.mjs");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      hostStepPath,
      `import fs from "node:fs";
fs.appendFileSync(process.env.HOST_LOG, JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  hostStep: process.env.HOST_STEP ?? null,
  workspaceStep: process.env.WORKSPACE_STEP ?? null
}) + "\\n");
`,
    );
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-run-123") process.exit(1);
if (cmd === "inspect" && target === "container-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-abc", State: { Running: true, Pid: 4321 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace/repo",
      env: {
        BASE: "container",
      },
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: {
        scope: "run",
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
      },
      lifecycle: {
        afterStart: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "container-step",
              args: ["{{container_name}}", "{{container_id}}", "{{container_pid}}"],
              env: {
                STEP: "container",
              },
              cwd: "/workspace",
              timeoutMs: 120000,
              user: "0",
              detach: true,
            },
            {
              kind: "command",
              target: "host",
              command: process.execPath,
              args: [hostStepPath, "{{container_pid}}"],
              env: {
                HOST_LOG: hostLogPath,
                HOST_STEP: "afterStart",
              },
              cwd: rootDir,
              timeoutMs: 120000,
              user: null,
              detach: false,
            },
          ],
          completedContainerId: null,
          completedAt: null,
          lastError: null,
        },
        onWorkspaceCreate: {
          steps: [
            {
              kind: "command",
              target: "host",
              command: process.execPath,
              args: [hostStepPath, "workspace"],
              env: {
                HOST_LOG: hostLogPath,
                WORKSPACE_STEP: "host",
              },
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
            {
              kind: "command",
              target: "container",
              command: "npm",
              args: ["install"],
              env: {
                CI: "1",
              },
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedAt: null,
          lastError: null,
        },
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const prepared = await withEnv(
      {
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: logPath,
        HOST_LOG: hostLogPath,
      },
      () => prepareExecutionEnvironment(environment),
    );

    assert.equal(prepared.containerId, "container-abc");
    assert.equal(prepared.lifecycle.afterStart.completedContainerId, "container-abc");
    assert.equal(typeof prepared.lifecycle.afterStart.completedAt, "string");
    assert.equal(typeof prepared.lifecycle.onWorkspaceCreate.completedAt, "string");

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const containerStep = commands.find((command) => command.includes("container-step"));
    assert.deepEqual(containerStep, [
      "exec",
      "-d",
      "--user",
      "0",
      "-w",
      "/workspace",
      "-e",
      "BASE=container",
      "-e",
      "STEP=container",
      "container-abc",
      "container-step",
      "task-runner-run-123",
      "container-abc",
      "4321",
    ]);
    const npmStep = commands.find((command) => command.includes("npm"));
    assert.deepEqual(npmStep, [
      "exec",
      "-i",
      "-w",
      "/workspace",
      "-e",
      "BASE=container",
      "-e",
      "CI=1",
      "container-abc",
      "npm",
      "install",
    ]);
    assert.ok(
      commands.findIndex((command) => command.includes("container-step")) <
        commands.findIndex((command) => command.includes("npm")),
    );
    assert.deepEqual(commands.at(-1), ["exec", "container-abc", "test", "-d", "/workspace/repo"]);

    const hostCommands = readFileSync(hostLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(hostCommands, [
      { cwd: rootDir, args: ["4321"], hostStep: "afterStart", workspaceStep: null },
      { cwd: workspacePath, args: ["workspace"], hostStep: null, workspaceStep: "host" },
    ]);
  }));

test("prepareExecutionEnvironment removes a newly-started container when workspace lifecycle fails", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir, stateDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-run-123") process.exit(1);
if (cmd === "inspect" && target === "container-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true, Pid: 4321 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec" && args.includes("npm")) process.exit(1);
if (cmd === "exec") process.exit(0);
if (cmd === "rm") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: {
        scope: "run",
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
      },
      lifecycle: {
        afterStart: null,
        onWorkspaceCreate: {
          steps: [
            {
              kind: "git-clone",
              target: "container",
              source: "/source",
              baseRef: "origin/main",
              branch: "feature/test",
              timeoutMs: null,
            },
            {
              kind: "command",
              target: "container",
              command: "npm",
              args: ["install"],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedAt: null,
          lastError: null,
        },
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    await assert.rejects(
      withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment),
      ),
      /workspace lifecycle failed: workspace lifecycle step 1 \(command: npm\) failed/,
    );
    assert.equal(
      existsSync(
        join(
          explicitWorkspaceLifecycleStatePath(stateDir, workspacePath),
          ".task-runner-workspace-lifecycle.json",
        ),
      ),
      false,
    );
    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(commands.at(-1), ["rm", "-f", "container-123"]);
  }));

test("prepareExecutionEnvironment fails afterStart before workspace lifecycle and cleans up new containers", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-run-123") process.exit(1);
if (cmd === "inspect" && target === "container-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true, Pid: 1234 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec" && args.includes("after-start")) process.exit(1);
if (cmd === "exec") process.exit(0);
if (cmd === "rm") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace/repo",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: {
        scope: "run",
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
      },
      lifecycle: {
        afterStart: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "after-start",
              args: [],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedContainerId: null,
          completedAt: null,
          lastError: null,
        },
        onWorkspaceCreate: {
          steps: [
            {
              kind: "git-clone",
              target: "container",
              source: "/source",
              baseRef: "origin/main",
              branch: "feature/test",
              timeoutMs: null,
            },
          ],
          completedAt: null,
          lastError: null,
        },
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    await assert.rejects(
      withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment),
      ),
      (error) => {
        assert.match(error.message, /afterStart lifecycle failed/);
        assert.equal(error.environment.containerId, null);
        assert.match(
          error.environment.lifecycle.afterStart.lastError,
          /afterStart lifecycle failed/,
        );
        return true;
      },
    );

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      commands.some((command) => command.includes("git")),
      false,
    );
    assert.deepEqual(commands.at(-1), ["rm", "-f", "container-123"]);
  }));

test("prepareExecutionEnvironment still removes a newly-started container after abort", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-run-123") process.exit(1);
if (cmd === "inspect" && target === "container-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true, Pid: 1234 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec" && args.includes("after-start")) {
  setTimeout(() => {}, 10_000);
} else {
  process.exit(0);
}
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: null,
      lifecycle: {
        afterStart: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "after-start",
              args: [],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedContainerId: null,
          completedAt: null,
          lastError: null,
        },
        onWorkspaceCreate: null,
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const controller = new AbortController();
    const preparing = withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment(environment, { signal: controller.signal }),
    );
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          existsSync(logPath) &&
          readFileSync(logPath, "utf8")
            .split("\n")
            .some((line) => line.includes("after-start"))
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(readFileSync(logPath, "utf8"), /after-start/);
      controller.abort();

      await assert.rejects(preparing, /afterStart lifecycle failed/);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(commands.at(-1), ["rm", "-f", "container-123"]);
  }));

test("prepareExecutionEnvironment rejects and removes a newly-started stopped container", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-run-123") process.exit(1);
if (cmd === "inspect" && target === "container-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: false, Pid: 0 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "rm") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: null,
      lifecycle: null,
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    await assert.rejects(
      withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment),
      ),
      /container task-runner-run-123 failed to start/,
    );

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(commands.at(-1), ["rm", "-f", "container-123"]);
    assert.equal(
      commands.some((command) => command.includes("test")),
      false,
    );
  }));

test("prepareExecutionEnvironment does not remove reused group containers on afterStart failure", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-group-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-group", State: { Running: true, Pid: 5678 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "exec" && args.includes("after-start")) process.exit(1);
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "group",
      containerName: "task-runner-group-123",
      containerId: null,
      workspace: null,
      lifecycle: {
        afterStart: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "after-start",
              args: [],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedContainerId: null,
          completedAt: null,
          lastError: null,
        },
        onWorkspaceCreate: null,
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    await assert.rejects(
      withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment),
      ),
      /afterStart lifecycle failed/,
    );

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      commands.some((command) => command[0] === "rm"),
      false,
    );
  }));

test("prepareExecutionEnvironment skips afterStart for the same container id and reruns for a new id", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "container-old") {
  process.stdout.write(JSON.stringify([{ Id: "container-old", State: { Running: true, Pid: 1111 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "inspect" && target === "container-new") {
  process.stdout.write(JSON.stringify([{ Id: "container-new", State: { Running: true, Pid: 2222 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: "container-old",
      workspace: null,
      lifecycle: {
        afterStart: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "after-start",
              args: ["{{container_pid}}"],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedContainerId: "container-old",
          completedAt: "2026-05-06T20:00:00.000Z",
          lastError: null,
        },
        onWorkspaceCreate: null,
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const skipped = await withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment(environment),
    );
    assert.equal(skipped.lifecycle.afterStart.completedContainerId, "container-old");

    const rerun = await withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment({ ...skipped, containerId: "container-new" }),
    );
    assert.equal(rerun.lifecycle.afterStart.completedContainerId, "container-new");

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const afterStartCommands = commands.filter((command) => command.includes("after-start"));
    assert.equal(afterStartCommands.length, 1);
    assert.ok(afterStartCommands[0].includes("2222"));
  }));

test("prepareExecutionEnvironment shares afterStart completion across group runs for the same container", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [cmd, target] = args;
if (cmd === "inspect" && target === "task-runner-group-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-shared", State: { Running: true, Pid: 5678 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "group",
      containerName: "task-runner-group-123",
      containerId: null,
      workspace: null,
      lifecycle: {
        afterStart: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "after-start",
              args: ["{{container_pid}}"],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedContainerId: null,
          completedAt: null,
          lastError: null,
        },
        onWorkspaceCreate: null,
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const first = await withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment(environment),
    );
    assert.equal(first.lifecycle.afterStart.completedContainerId, "container-shared");

    const second = await withEnv(
      { PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath },
      () => prepareExecutionEnvironment(structuredClone(environment)),
    );
    assert.equal(second.lifecycle.afterStart.completedContainerId, "container-shared");

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const afterStartCommands = commands.filter((command) => command.includes("after-start"));
    assert.equal(afterStartCommands.length, 1);
    assert.ok(afterStartCommands[0].includes("5678"));
  }));

test("prepareExecutionEnvironment waits for a contended workspace lifecycle lock", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir, stateDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
    const lifecycleStatePath = explicitWorkspaceLifecycleStatePath(stateDir, workspacePath);
    const lockPath = join(lifecycleStatePath, ".task-runner-workspace-lifecycle.lock");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd, target] = process.argv.slice(2);
if (cmd === "inspect") {
  if (target === "task-runner-run-123") process.exit(1);
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: {
        scope: "run",
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
      },
      lifecycle: {
        afterStart: null,
        onWorkspaceCreate: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "npm",
              args: ["install"],
              env: {},
              cwd: null,
              timeoutMs: null,
              user: null,
              detach: false,
            },
          ],
          completedAt: null,
          lastError: null,
        },
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    const release = setTimeout(() => rmSync(lockPath, { recursive: true, force: true }), 100);
    try {
      await withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment, { signal: AbortSignal.timeout(2_000) }),
      );
    } finally {
      clearTimeout(release);
    }

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(commands.some((command) => command.includes("npm")));
    assert.ok(existsSync(join(lifecycleStatePath, ".task-runner-workspace-lifecycle.json")));
  }));

test("prepareExecutionEnvironment keeps workspace lifecycle locks alive for custom timeout budgets", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir, stateDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
    const lifecycleStatePath = explicitWorkspaceLifecycleStatePath(stateDir, workspacePath);
    const lockPath = join(lifecycleStatePath, ".task-runner-workspace-lifecycle.lock");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      })}\n`,
    );
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd, target] = process.argv.slice(2);
if (cmd === "inspect") {
  if (target === "task-runner-run-123") process.exit(1);
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true, Pid: 1234 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/workspace",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: {
        scope: "run",
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
      },
      lifecycle: {
        afterStart: null,
        onWorkspaceCreate: {
          steps: [
            {
              kind: "command",
              target: "container",
              command: "npm",
              args: ["install"],
              env: {},
              cwd: null,
              timeoutMs: 2 * 60 * 60_000,
              user: null,
              detach: false,
            },
          ],
          completedAt: null,
          lastError: null,
        },
      },
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    await assert.rejects(
      withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment, { signal: AbortSignal.timeout(200) }),
      ),
      /abort/i,
    );

    const commands = existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    assert.equal(
      commands.some((command) => command.includes("npm")),
      false,
    );
  }));

test("prepareExecutionEnvironment removes a newly-started container when cwd validation fails", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const [cmd, target] = process.argv.slice(2);
if (cmd === "inspect" && target === "task-runner-run-123") process.exit(1);
if (cmd === "inspect" && target === "container-123") {
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true, Pid: 1234 }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
if (cmd === "exec") process.exit(1);
if (cmd === "rm") process.exit(0);
process.exit(0);
`,
      { mode: 0o755 },
    );

    const environment = {
      kind: "container",
      mode: "managed",
      name: "workspace-dev",
      sourcePath: null,
      engine: "docker",
      cwd: "/missing",
      env: {},
      extraExecArgs: [],
      lastValidatedAt: null,
      lastError: null,
      image: "node:22",
      lifetime: "run",
      containerName: "task-runner-run-123",
      containerId: null,
      workspace: null,
      sessionMounts: [],
      mounts: [],
      network: "default",
      security: { capDrop: [], capAdd: [] },
      extraRunArgs: [],
      cleanup: { policy: "manual", cleanedAt: null, lastError: null },
    };

    await assert.rejects(
      withEnv({ PATH: `${binDir}:${process.env.PATH}`, FAKE_DOCKER_LOG: logPath }, () =>
        prepareExecutionEnvironment(environment),
      ),
      /docker exec failed/,
    );

    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(commands.at(-1), ["rm", "-f", "container-123"]);
  }));
