import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { VarResolutionError, runAgent } from "../packages/core/dist/core/run/run-loop.js";
import {
  readManifestForPrompt,
  updateTasksForPrompt,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

const INTERP_AGENT = `---
schemaVersion: 1
name: interp
backend: claude
---
Agent role.
`;

const INTERP_ASSIGNMENT = `---
schemaVersion: 1
name: interp-work
maxRetries: 1
vars:
  repo_path:
    type: string
    required: true
    sources: [cli]
  scope:
    type: string
    required: false
    sources: [cli]
    default: full
tasks:
  - id: t1
    title: Review {{repo_path}} at scope {{scope}}
    body: |
      Work against the repository at \`{{repo_path}}\`. Scope is
      \`{{scope}}\`. Capture findings here.
  - id: t2
    title: Second task
    body: |
      Also record the run id {{run_id}} and assignment path
      {{assignment_path}}. Assignment name: {{assignment_name}}.
      Config dir: {{config_dir}}. State dir: {{state_dir}}.
---
Work on {{repo_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-interp-"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
}

function ackBackend(onAssignmentPath) {
  return {
    id: "mock",
    async invoke(ctx) {
      const manifest = readManifestForPrompt(ctx.prompt);
      onAssignmentPath(manifest.assignmentPath);
      updateTasksForPrompt(ctx.prompt, {
        t1: { status: "completed" },
        t2: { status: "completed" },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "sess-interp",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function runIn(baseDir, cliVars) {
  return withSharedRuntimeEnv(baseDir, async () => {
    let assignmentPath = null;
    const loaded = loadAgentConfig("interp", baseDir);
    const loadedAssignment = loadAssignmentConfig("interp-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      const outcome = await runAgent({
        loaded,
        loadedAssignment,
        cliVars,
        backend: ackBackend((path) => {
          assignmentPath = path;
        }),
        stderr: () => {},
        stdout: () => {},
      });
      return { ...outcome, assignmentPath };
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("task title and body interpolate {{var}} refs from assignment vars", async () => {
  const dir = tempDir();
  writeAgent(dir, "interp", INTERP_AGENT);
  writeAssignment(dir, "interp-work", INTERP_ASSIGNMENT);

  const outcome = await runIn(dir, { repo_path: "/tmp/fake-repo", scope: "unstaged" });
  assert.equal(outcome.exitCode, 0);

  // The manifest snapshot should carry interpolated title + body, not the raw templates.
  const t1 = outcome.manifest.finalTasks.t1;
  assert.equal(t1.title, "Review /tmp/fake-repo at scope unstaged");
  assert.match(t1.body, /Work against the repository at `\/tmp\/fake-repo`\./);
  assert.match(t1.body, /Scope is\s+`unstaged`\./);
  assert.doesNotMatch(t1.body, /\{\{/);

  // Runner-injected vars also interpolate.
  const t2 = outcome.manifest.finalTasks.t2;
  assert.match(t2.body, new RegExp(`run id ${outcome.runId}`));
  assert.ok(t2.body.includes(outcome.assignmentPath));
  assert.match(t2.body, /Assignment name: interp-work\./);
  assert.match(t2.body, new RegExp(`Config dir: ${escapeRegExp(dir)}\\.`));
  assert.match(t2.body, new RegExp(`State dir: ${escapeRegExp(dir)}\\.`));
  assert.doesNotMatch(t2.body, /\{\{/);
});

test("task body var uses the assignment's default when no CLI value", async () => {
  const dir = tempDir();
  writeAgent(dir, "interp", INTERP_AGENT);
  writeAssignment(dir, "interp-work", INTERP_ASSIGNMENT);

  // Only provide the required var; `scope` should use its default "full"
  const outcome = await runIn(dir, { repo_path: "/tmp/fake-repo" });
  const t1 = outcome.manifest.finalTasks.t1;
  assert.match(t1.title, /scope full$/);
  assert.match(t1.body, /Scope is\s+`full`\./);
});

test("workspace assignment-seed.md is generated for interpolated task bodies", async () => {
  const dir = tempDir();
  writeAgent(dir, "interp", INTERP_AGENT);
  writeAssignment(dir, "interp-work", INTERP_ASSIGNMENT);

  const outcome = await runIn(dir, { repo_path: "/tmp/fake-repo", scope: "staged" });
  assert.equal(outcome.assignmentPath, join(outcome.workspaceDir, "assignment-seed.md"));
  assert.equal(existsSync(outcome.assignmentPath), true);
  assert.match(
    outcome.manifest.finalTasks.t1.body,
    /Work against the repository at `\/tmp\/fake-repo`/,
  );
  assert.match(outcome.manifest.finalTasks.t1.body, /Scope is\s+`staged`/);
});

test("unknown CLI vars are rejected when the assignment declares a schema", async () => {
  const dir = tempDir();
  writeAgent(dir, "interp", INTERP_AGENT);
  writeAssignment(dir, "interp-work", INTERP_ASSIGNMENT);

  await assert.rejects(
    () => runIn(dir, { repo_path: "/tmp/fake-repo", extra_scope: "staged" }),
    (err) => {
      assert.ok(err instanceof VarResolutionError);
      assert.match(err.message, /unknown --var key\(s\): extra_scope/);
      return true;
    },
  );
});

test("referenced named task bodies still interpolate {{var}} values during run construction", async () => {
  const dir = tempDir();
  writeAgent(dir, "interp", INTERP_AGENT);
  writeTask(
    dir,
    "review/reuse",
    `---
schemaVersion: 1
title: Review {{repo_path}}
---
Use scope {{scope}} inside {{repo_path}}.
`,
  );
  writeAssignment(
    dir,
    "named-task-work",
    `---
schemaVersion: 1
name: named-task-work
maxRetries: 1
vars:
  repo_path:
    type: string
    required: true
    sources: [cli]
  scope:
    type: string
    required: false
    sources: [cli]
    default: full
tasks:
  - review/reuse
---
Work on {{repo_path}}.
`,
  );

  const outcome = await withSharedRuntimeEnv(dir, async () => {
    let assignmentPath = null;
    const loaded = loadAgentConfig("interp", dir);
    const loadedAssignment = loadAssignmentConfig("named-task-work", dir);
    const backend = {
      id: "mock",
      async invoke(ctx) {
        const manifest = readManifestForPrompt(ctx.prompt);
        assignmentPath = manifest.assignmentPath;
        updateTasksForPrompt(ctx.prompt, {
          "review/reuse": { status: "completed" },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          sessionId: "sess-named-task",
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      },
    };
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: { repo_path: "/tmp/named-repo", scope: "staged" },
        backend,
        stderr: () => {},
        stdout: () => {},
      }).then((result) => ({ ...result, assignmentPath }));
    } finally {
      process.chdir(originalCwd);
    }
  });

  const task = outcome.manifest.finalTasks["review/reuse"];
  assert.equal(task.title, "Review /tmp/named-repo");
  assert.equal(task.body, "Use scope staged inside /tmp/named-repo.");
  assert.doesNotMatch(task.body, /\{\{/);
});
