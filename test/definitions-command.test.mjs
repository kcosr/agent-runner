import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CLI = resolve("dist/cli.js");

function run(args, opts = {}) {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    timeout: 10_000,
  });
}

function runExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI, ...args], {
      encoding: "utf8",
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      timeout: 10_000,
    });
    assert.fail("expected non-zero exit");
  } catch (err) {
    assert.ok(err.status !== 0, `expected non-zero exit, got ${err.status}`);
    return { status: err.status, stderr: err.stderr, stdout: err.stdout };
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-def-test-"));
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

const AGENT_BODY = `---
schemaVersion: 1
name: test-agent
backend: claude
model: claude-sonnet-4-6
---
You are a test agent.
`;

const ASSIGNMENT_BODY = `---
schemaVersion: 1
name: test-work
tasks:
  - id: t1
    title: Do the thing
vars:
  repo_path:
    type: string
    required: true
    source: cli
---
Work instructions.
`;

// ── list agents ─���───────────────────────────────────────────────────

test("list agents text output", () => {
  const dir = tempDir();
  writeAgent(dir, "alpha", AGENT_BODY);
  writeAgent(dir, "beta", AGENT_BODY.replace("test-agent", "beta"));

  const out = run(["list", "agents"], { cwd: dir });
  assert.ok(out.includes("alpha"));
  assert.ok(out.includes("beta"));
});

test("list agents JSON output", () => {
  const dir = tempDir();
  writeAgent(dir, "alpha", AGENT_BODY);

  const out = run(["list", "agents", "--output-format", "json"], { cwd: dir });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 1);
  assert.equal(parsed[0].name, "alpha");
  assert.equal(parsed[0].root, "local");
  assert.ok(parsed[0].path.endsWith("agent.md"));
});

test("list assignments text output", () => {
  const dir = tempDir();
  writeAssignment(dir, "work-a", ASSIGNMENT_BODY);

  const out = run(["list", "assignments"], { cwd: dir });
  assert.ok(out.includes("work-a"));
});

test("list assignments JSON output", () => {
  const dir = tempDir();
  writeAssignment(dir, "work-a", ASSIGNMENT_BODY);

  const out = run(["list", "assignments", "--output-format", "json"], { cwd: dir });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].name, "work-a");
});

test("list with empty directory produces empty output", () => {
  const dir = tempDir();
  const out = run(["list", "agents"], { cwd: dir });
  assert.ok(out.includes("No agent definitions found"));
});

// ── list error paths ────��───────────────────────────────────────────

test("list with no kind exits 3", () => {
  const { status } = runExpectFail(["list"]);
  assert.equal(status, 3);
});

test("list with unknown kind exits 3", () => {
  const { status, stderr } = runExpectFail(["list", "foobar"]);
  assert.equal(status, 3);
  assert.ok(stderr.includes("foobar"));
});

// ── show agent ──────────────────────────────────────────────────────

test("show agent text output", () => {
  const dir = tempDir();
  writeAgent(dir, "demo", AGENT_BODY);

  const out = run(["show", "agent", "demo"], { cwd: dir });
  assert.ok(out.includes("Agent: test-agent"));
  assert.ok(out.includes("backend:"));
  assert.ok(out.includes("claude"));
  assert.ok(out.includes("You are a test agent."));
});

test("show agent JSON output", () => {
  const dir = tempDir();
  writeAgent(dir, "demo", AGENT_BODY);

  const out = run(["show", "agent", "demo", "--output-format", "json"], { cwd: dir });
  const parsed = JSON.parse(out);
  assert.equal(parsed.config.name, "test-agent");
  assert.equal(parsed.config.backend, "claude");
  assert.ok(parsed.instructions.includes("test agent"));
  assert.ok(parsed.sourcePath.endsWith("agent.md"));
});

test("show agent by direct path", () => {
  const dir = tempDir();
  writeAgent(dir, "demo", AGENT_BODY);
  const path = join(dir, "agents", "demo", "agent.md");

  const out = run(["show", "agent", path], { cwd: dir });
  assert.ok(out.includes("Agent: test-agent"));
});

// ── show assignment ─────────────���───────────────────────────────────

test("show assignment text output", () => {
  const dir = tempDir();
  writeAssignment(dir, "demo", ASSIGNMENT_BODY);

  const out = run(["show", "assignment", "demo"], { cwd: dir });
  assert.ok(out.includes("Assignment: test-work"));
  assert.ok(out.includes("tasks:"));
  assert.ok(out.includes("t1: Do the thing"));
  assert.ok(out.includes("vars:"));
  assert.ok(out.includes("repo_path"));
});

test("show assignment JSON output", () => {
  const dir = tempDir();
  writeAssignment(dir, "demo", ASSIGNMENT_BODY);

  const out = run(["show", "assignment", "demo", "--output-format", "json"], { cwd: dir });
  const parsed = JSON.parse(out);
  assert.equal(parsed.config.name, "test-work");
  assert.equal(parsed.config.tasks.length, 1);
  assert.equal(parsed.config.tasks[0].id, "t1");
  assert.ok("repo_path" in parsed.config.vars);
  assert.ok(parsed.instructions.includes("Work instructions"));
});

// ── show error paths ──────��─────────────────────────────────────────

test("show with no kind exits 3", () => {
  const { status } = runExpectFail(["show"]);
  assert.equal(status, 3);
});

test("show with invalid kind exits 3", () => {
  const { status, stderr } = runExpectFail(["show", "bogus", "x"]);
  assert.equal(status, 3);
  assert.ok(stderr.includes("bogus"));
});

test("show agent with no target exits 3", () => {
  const { status } = runExpectFail(["show", "agent"]);
  assert.equal(status, 3);
});

test("show agent nonexistent exits 3", () => {
  const dir = tempDir();
  const { status } = runExpectFail(["show", "agent", "nope"], { cwd: dir });
  assert.equal(status, 3);
});

test("show assignment nonexistent exits 3", () => {
  const dir = tempDir();
  const { status } = runExpectFail(["show", "assignment", "nope"], { cwd: dir });
  assert.equal(status, 3);
});

// ── read-only verification ────────��─────────────────────────────────

test("list and show commands create no .task-runner run artifacts", () => {
  const dir = tempDir();
  writeAgent(dir, "demo", AGENT_BODY);
  writeAssignment(dir, "demo", ASSIGNMENT_BODY);

  run(["list", "agents"], { cwd: dir });
  run(["list", "assignments"], { cwd: dir });
  run(["show", "agent", "demo"], { cwd: dir });
  run(["show", "assignment", "demo"], { cwd: dir });

  assert.ok(!existsSync(join(dir, ".task-runner")));
});
