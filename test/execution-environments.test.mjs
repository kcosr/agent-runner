import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildEnvironmentLauncher,
  resolveFreshExecutionEnvironment,
} from "../packages/core/dist/core/run/execution-environments.js";
import { withRuntimeRoots } from "./helpers/runtime-paths.mjs";

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

  assert.deepEqual(buildEnvironmentLauncher(environment, { FOO: "from-backend", BAR: "baz" }), {
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
      "FOO=from-environment",
      "-e",
      "BAR=baz",
      "-e",
      "ONLY_ENVIRONMENT=yes",
      "devbox",
    ],
    name: null,
    source: "inline",
  });
});
