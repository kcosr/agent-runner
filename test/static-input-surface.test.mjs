import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCustomBackends } from "../packages/core/dist/backends/registry.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { resolveStaticInputSurface } from "../packages/core/dist/core/run/static-input-surface.js";
import { withEnv, withRuntimeRoots } from "./helpers/runtime-paths.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PLANNER_AGENT_PATH = new URL("../agents/planner/agent.md", import.meta.url).pathname;
const CODE_REVIEWER_AGENT_PATH = new URL("../agents/code-reviewer/agent.md", import.meta.url)
  .pathname;
const PLAN_FEATURE_ASSIGNMENT_PATH = new URL(
  "../assignments/plan-feature/assignment.md",
  import.meta.url,
).pathname;
const PLAN_IMPLEMENT_FEATURE_ASSIGNMENT_PATH = new URL(
  "../assignments/plan-implement-feature/assignment.md",
  import.meta.url,
).pathname;
const CODE_REVIEW_ASSIGNMENT_PATH = new URL(
  "../assignments/code-review/assignment.md",
  import.meta.url,
).pathname;
const CODE_REVIEW_DIRECT_ASSIGNMENT_PATH = new URL(
  "../assignments/code-review-direct/assignment.md",
  import.meta.url,
).pathname;

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.md"), body);
}

function writeAssignment(baseDir, name, body) {
  const assignmentDir = join(baseDir, "assignments", name);
  mkdirSync(assignmentDir, { recursive: true });
  writeFileSync(join(assignmentDir, "assignment.md"), body);
}

function writeBackend(baseDir, name, body) {
  const backendDir = join(baseDir, "backends", name);
  mkdirSync(backendDir, { recursive: true });
  writeFileSync(join(backendDir, "backend.mjs"), body);
}

function fieldByKey(fields, key) {
  const field = fields.find((entry) => entry.key === key);
  assert.ok(field, `expected field ${key}`);
  return field;
}

test("static input surface: built-in planner + plan-feature surfaces the documented static fields", () =>
  withEnv({ TASK_RUNNER_CONFIG_DIR: REPO_ROOT }, () => {
    const loadedAgent = loadAgentConfig(PLANNER_AGENT_PATH, REPO_ROOT);
    const loadedAssignment = loadAssignmentConfig(PLAN_FEATURE_ASSIGNMENT_PATH, REPO_ROOT);

    const surface = resolveStaticInputSurface(loadedAgent, loadedAssignment);
    const backend = fieldByKey(surface.runSettings, "backend");
    const timeoutSec = fieldByKey(surface.runSettings, "timeoutSec");
    const unrestricted = fieldByKey(surface.runSettings, "unrestricted");
    const maxRetries = fieldByKey(surface.runSettings, "maxRetries");
    const message = fieldByKey(surface.runSettings, "message");
    const model = fieldByKey(surface.runSettings, "model");
    const effort = fieldByKey(surface.runSettings, "effort");

    assert.deepEqual(
      surface.runSettings.map((field) => field.key),
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

    assert.equal(backend.value, "codex");
    assert.equal(backend.source, "agent");
    assert.equal(timeoutSec.value, 14400);
    assert.equal(timeoutSec.source, "agent");
    assert.equal(unrestricted.value, true);
    assert.equal(unrestricted.source, "schema_default");
    assert.equal(maxRetries.value, 4);
    assert.equal(maxRetries.source, "assignment");

    assert.equal(message.editable, true);
    assert.equal(message.valueStatus, "unset");
    assert.equal(message.source, "available_override");

    assert.equal(model.editable, true);
    assert.equal(model.valueStatus, "concrete");
    assert.equal(model.source, "agent");
    assert.equal(model.value, "gpt-5.5");

    assert.equal(effort.editable, true);
    assert.equal(effort.valueStatus, "concrete");
    assert.equal(effort.source, "agent");
    assert.equal(effort.value, "high");

    assert.deepEqual(
      surface.assignmentInputs.map((field) => field.key),
      ["worktree_slug", "worktree_base_ref"],
    );
    const baseRef = fieldByKey(surface.assignmentInputs, "worktree_base_ref");
    assert.equal(fieldByKey(surface.assignmentInputs, "worktree_slug").required, true);
    assert.notEqual(baseRef.required, true);
    assert.equal(baseRef.source, "var_default");
    assert.equal(baseRef.value, "origin/main");
    assert.ok(!surface.assignmentInputs.some((field) => field.key === "worktree_path"));
    assert.ok(!surface.assignmentInputs.some((field) => field.key === "repo_root"));
  }));

test("static input surface: built-in planner + plan-implement-feature has no assignment vars", () =>
  withEnv({ TASK_RUNNER_CONFIG_DIR: REPO_ROOT }, () => {
    const loadedAgent = loadAgentConfig(PLANNER_AGENT_PATH, REPO_ROOT);
    const loadedAssignment = loadAssignmentConfig(
      PLAN_IMPLEMENT_FEATURE_ASSIGNMENT_PATH,
      REPO_ROOT,
    );

    const surface = resolveStaticInputSurface(loadedAgent, loadedAssignment);
    const maxRetries = fieldByKey(surface.runSettings, "maxRetries");
    const message = fieldByKey(surface.runSettings, "message");

    assert.deepEqual(
      surface.runSettings.map((field) => field.key),
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
    assert.equal(maxRetries.value, 4);
    assert.equal(maxRetries.source, "assignment");
    assert.equal(message.editable, true);
    assert.equal(message.valueStatus, "unset");
    assert.deepEqual(surface.assignmentInputs, []);
  }));

test("static input surface: review assignments expose the correct CLI/Web inputs", () =>
  withEnv({ TASK_RUNNER_CONFIG_DIR: REPO_ROOT }, () => {
    const loadedAgent = loadAgentConfig(CODE_REVIEWER_AGENT_PATH, REPO_ROOT);
    const implementationReview = resolveStaticInputSurface(
      loadedAgent,
      loadAssignmentConfig(CODE_REVIEW_ASSIGNMENT_PATH, REPO_ROOT),
    );
    const directReview = resolveStaticInputSurface(
      loadedAgent,
      loadAssignmentConfig(CODE_REVIEW_DIRECT_ASSIGNMENT_PATH, REPO_ROOT),
    );

    assert.deepEqual(
      implementationReview.assignmentInputs.map((field) => field.key),
      ["range", "implementation_run_id"],
    );
    assert.equal(fieldByKey(implementationReview.assignmentInputs, "range").value, "full");
    assert.equal(
      fieldByKey(implementationReview.assignmentInputs, "implementation_run_id").required,
      true,
    );

    assert.deepEqual(
      directReview.assignmentInputs.map((field) => field.key),
      ["range"],
    );
    assert.equal(fieldByKey(directReview.assignmentInputs, "range").value, "full");
    assert.ok(
      !directReview.assignmentInputs.some((field) => field.key === "implementation_run_id"),
    );
  }));

test("static input surface: backend choices include loaded custom backend names", async () =>
  withRuntimeRoots("task-runner-static-input-backends-", async ({ rootDir, configDir }) => {
    writeBackend(
      configDir,
      "my-agent",
      `export default {
        id: "my-agent",
        async invoke() {
          return { exitCode: 0, signal: null, timedOut: false, aborted: false };
        }
      };`,
    );
    writeAgent(
      configDir,
      "custom-agent",
      `---
schemaVersion: 1
name: custom-agent
backend: my-agent
---
Custom backend agent.
`,
    );

    await loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir });
    const surface = resolveStaticInputSurface(loadAgentConfig("custom-agent", rootDir));
    const backend = fieldByKey(surface.runSettings, "backend");

    assert.equal(backend.value, "my-agent");
    assert.ok(backend.enumValues.includes("my-agent"));
    assert.ok(backend.enumValues.includes("codex"));
  }));

test("static input surface: launcher path and inline definitions preserve authored values", () =>
  withRuntimeRoots("task-runner-static-input-launchers-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "path-launcher",
      `---
schemaVersion: 1
name: path-launcher
backend: codex
launcher: ./launchers/prefix.yml
---
Path launcher fixture.
`,
    );
    writeAgent(
      configDir,
      "inline-launcher",
      `---
schemaVersion: 1
name: inline-launcher
backend: codex
launcher:
  command: env
  args: [TASK_RUNNER_TEST, "1"]
---
Inline launcher fixture.
`,
    );

    const pathSurface = resolveStaticInputSurface(loadAgentConfig("path-launcher", rootDir));
    const inlineSurface = resolveStaticInputSurface(loadAgentConfig("inline-launcher", rootDir));

    assert.equal(
      fieldByKey(pathSurface.runSettings, "launcher").value,
      join(configDir, "agents", "path-launcher", "launchers", "prefix.yml"),
    );

    assert.deepEqual(fieldByKey(inlineSurface.runSettings, "launcher").value, {
      command: "env",
      args: ["TASK_RUNNER_TEST", "1"],
    });
  }));

test("static input surface: lock union and CLI-capable var metadata are preserved", () =>
  withRuntimeRoots("task-runner-static-input-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "fixture",
      `---
schemaVersion: 1
name: fixture
backend: codex
launcher: ssh-wrap
lockedFields: [message, model]
---
Fixture agent.
`,
    );
    writeAssignment(
      configDir,
      "fixture-work",
      `---
schemaVersion: 1
name: fixture-work
cwd: packages/core
message: ship it
maxRetries: 5
lockedFields: [cwd, maxRetries, message]
vars:
  cli_default:
    type: string
    sources: [cli, web]
    default: alpha
  env_only:
    type: string
    sources: [env]
  parent_only:
    type: string
    sources: [parent]
  mixed_default:
    type: enum
    values: [small, large]
    sources: [cli, web, env]
    default: large
  cli_prepare_required:
    type: string
    required: true
    requiredAt: prepare
    sources: [cli, web]
  cli_initial_required:
    type: boolean
    required: true
    sources: [cli, web]
---
Fixture assignment.
`,
    );

    const loadedAgent = loadAgentConfig("fixture", rootDir);
    const loadedAssignment = loadAssignmentConfig("fixture-work", rootDir);
    const surface = resolveStaticInputSurface(loadedAgent, loadedAssignment);

    const cwd = fieldByKey(surface.runSettings, "cwd");
    const launcher = fieldByKey(surface.runSettings, "launcher");
    const model = fieldByKey(surface.runSettings, "model");
    const effort = fieldByKey(surface.runSettings, "effort");
    const message = fieldByKey(surface.runSettings, "message");
    const maxRetries = fieldByKey(surface.runSettings, "maxRetries");

    assert.equal(cwd.locked, true);
    assert.equal(cwd.editable, false);
    assert.equal(cwd.value, "packages/core");
    assert.equal(cwd.source, "assignment");

    assert.equal(launcher.locked, false);
    assert.equal(launcher.editable, true);
    assert.equal(launcher.value, "ssh-wrap");
    assert.equal(launcher.source, "agent");

    assert.equal(model.locked, true);
    assert.equal(model.editable, false);
    assert.equal(model.valueStatus, "delegated");
    assert.equal(model.hiddenWhenUnset, true);
    assert.equal(model.value, null);

    assert.equal(effort.locked, false);
    assert.equal(effort.editable, true);
    assert.equal(effort.valueStatus, "delegated");
    assert.equal(effort.hiddenWhenUnset, false);

    assert.equal(message.locked, true);
    assert.equal(message.editable, false);
    assert.equal(message.value, "ship it");

    assert.equal(maxRetries.locked, true);
    assert.equal(maxRetries.editable, false);
    assert.equal(maxRetries.value, 5);
    assert.equal(maxRetries.source, "assignment");

    assert.deepEqual(
      surface.assignmentInputs.map((field) => field.key),
      ["cli_default", "mixed_default", "cli_prepare_required", "cli_initial_required"],
    );

    const cliDefault = fieldByKey(surface.assignmentInputs, "cli_default");
    const mixedDefault = fieldByKey(surface.assignmentInputs, "mixed_default");
    const cliPrepareRequired = fieldByKey(surface.assignmentInputs, "cli_prepare_required");
    const cliInitialRequired = fieldByKey(surface.assignmentInputs, "cli_initial_required");

    assert.equal(cliDefault.value, "alpha");
    assert.equal(cliDefault.source, "var_default");

    assert.equal(mixedDefault.inputKind, "enum");
    assert.deepEqual(mixedDefault.enumValues, ["small", "large"]);
    assert.equal(mixedDefault.value, "large");
    assert.equal(mixedDefault.source, "var_default");

    assert.equal(cliPrepareRequired.valueStatus, "unset");
    assert.equal(cliPrepareRequired.required, undefined);

    assert.equal(cliInitialRequired.valueStatus, "unset");
    assert.equal(cliInitialRequired.required, true);
  }));

test("static input surface: agent-only resolution keeps run-loop defaults without inventing assignment state", () =>
  withRuntimeRoots("task-runner-static-input-agent-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "agent-only",
      `---
schemaVersion: 1
name: agent-only
backend: claude
---
Agent only.
`,
    );

    const loadedAgent = loadAgentConfig("agent-only", rootDir);
    const surface = resolveStaticInputSurface(loadedAgent);

    assert.deepEqual(surface.assignmentInputs, []);
    assert.equal(fieldByKey(surface.runSettings, "cwd").valueStatus, "unset");
    assert.equal(fieldByKey(surface.runSettings, "cwd").value, null);
    assert.equal(fieldByKey(surface.runSettings, "message").valueStatus, "unset");
    assert.equal(fieldByKey(surface.runSettings, "message").value, null);
    assert.equal(fieldByKey(surface.runSettings, "maxRetries").value, 3);
    assert.equal(fieldByKey(surface.runSettings, "maxRetries").source, "run_loop_default");
    assert.equal(fieldByKey(surface.runSettings, "unrestricted").source, "schema_default");
    assert.equal(fieldByKey(surface.runSettings, "model").valueStatus, "delegated");
    assert.equal(fieldByKey(surface.runSettings, "model").value, null);
    assert.equal(fieldByKey(surface.runSettings, "effort").valueStatus, "delegated");
    assert.equal(fieldByKey(surface.runSettings, "effort").value, null);
  }));
