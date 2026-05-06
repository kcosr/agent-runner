import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    onCreate:
      - kind: command
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
      lifecycle: {
        onCreate: [
          {
            kind: "command",
            command: "sh",
            args: ["-lc", "echo /workspace ready"],
            env: {
              WORKSPACE_HOST: join(stateDir, "group-workspaces", "group-123"),
            },
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
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
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
        hostRoot: null,
        hostPath: workspacePath,
        containerPath: "/workspace",
        mode: "rw",
        create: true,
        createdAt: null,
        lifecycle: {
          onCreate: [
            {
              kind: "git-clone",
              source: "/source",
              baseRef: "origin/main",
              branch: "feature/test",
            },
            {
              kind: "command",
              command: "npm",
              args: ["install"],
              env: {
                CI: "1",
              },
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
    const lifecycleCompletedAt = prepared.workspace.lifecycle.completedAt;
    assert.equal(typeof lifecycleCompletedAt, "string");
    assert.ok(
      existsSync(
        join(`${workspacePath}.task-runner-lifecycle`, ".task-runner-workspace-lifecycle.json"),
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

test("prepareExecutionEnvironment removes a newly-started container when workspace lifecycle fails", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
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
        lifecycle: {
          onCreate: [
            {
              kind: "git-clone",
              source: "/source",
              baseRef: "origin/main",
              branch: "feature/test",
            },
            {
              kind: "command",
              command: "npm",
              args: ["install"],
              env: {},
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
        join(`${workspacePath}.task-runner-lifecycle`, ".task-runner-workspace-lifecycle.json"),
      ),
      false,
    );
    const commands = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(commands.at(-1), ["rm", "-f", "container-123"]);
  }));

test("prepareExecutionEnvironment waits for a contended workspace lifecycle lock", async () =>
  withRuntimeRoots("task-runner-environment-", async ({ rootDir }) => {
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker.log");
    const workspacePath = join(rootDir, "workspace");
    const lifecycleStatePath = `${workspacePath}.task-runner-lifecycle`;
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
        lifecycle: {
          onCreate: [
            {
              kind: "command",
              command: "npm",
              args: ["install"],
              env: {},
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
