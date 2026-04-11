import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";

const INTERP_AGENT = `---
schemaVersion: 1
name: interp
backend: claude
maxRetries: 1
---
Agent role.
`;

const INTERP_ASSIGNMENT = `---
schemaVersion: 1
name: interp-work
vars:
  repo_path:
    type: string
    required: true
    source: cli
  scope:
    type: string
    required: false
    source: cli
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
      {{assignment_path}} so the notes are self-contained.
---
Work on {{repo_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-interp-"));
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

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

function ackBackend() {
  return {
    id: "mock",
    async invoke(ctx) {
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      if (match) {
        const absPlan = `./${match[0]}`;
        let plan = readFileSync(absPlan, "utf8");
        for (const id of ["t1", "t2"]) plan = editStatus(plan, id, "completed");
        writeFileSync(absPlan, plan, "utf8");
      }
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
  const loaded = loadAgentConfig("interp", baseDir);
  const loadedAssignment = loadAssignmentConfig("interp-work", baseDir);
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars,
      backend: ackBackend(),
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
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

  // Runner-injected vars (run_id, assignment_path) also interpolate.
  const t2 = outcome.manifest.finalTasks.t2;
  assert.match(t2.body, new RegExp(`run id ${outcome.runId}`));
  assert.match(t2.body, /assignment path\s+\/\S*\.task-runner\/\S*\/assignment\.md/);
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

test("workspace assignment.md on disk contains interpolated task bodies", async () => {
  const dir = tempDir();
  writeAgent(dir, "interp", INTERP_AGENT);
  writeAssignment(dir, "interp-work", INTERP_ASSIGNMENT);

  const outcome = await runIn(dir, { repo_path: "/tmp/fake-repo", scope: "staged" });
  const plan = readFileSync(join(outcome.workspaceDir, "assignment.md"), "utf8");
  assert.match(plan, /Work against the repository at `\/tmp\/fake-repo`/);
  assert.match(plan, /Scope is\s+`staged`/);
  assert.doesNotMatch(plan, /\{\{/);
});
