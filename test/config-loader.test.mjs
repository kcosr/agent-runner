import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
  resolveAgentPath,
  resolveAssignmentPath,
} from "../packages/core/dist/config/loader.js";
import { withEnv, withRuntimeRoots } from "./helpers/runtime-paths.mjs";

const MINIMAL_AGENT = `---
schemaVersion: 1
name: demo
backend: claude
---
You are an assistant.
`;

const MINIMAL_ASSIGNMENT = `---
schemaVersion: 1
name: demo-work
tasks:
  - id: t1
    title: Do the thing
    body: First thing to do.
---
Work on the repo. Plan at {{assignment_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-loader-extra-"));
}

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "agent.md");
  writeFileSync(path, body);
  return path;
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "assignment.md");
  writeFileSync(path, body);
  return path;
}

const BUILTIN_PLAN_FEATURE_PATH = resolvePath(
  new URL("../assignments/plan-feature/assignment.md", import.meta.url).pathname,
);
const BUILTIN_PLAN_TEMPLATE_PATH = resolvePath(
  new URL("../assignments/plan-feature/template.md", import.meta.url).pathname,
);
const BUILTIN_PLAN_REVIEW_PATH = resolvePath(
  new URL("../assignments/plan-review/assignment.md", import.meta.url).pathname,
);
const BUILTIN_CODE_REVIEW_PATH = resolvePath(
  new URL("../assignments/code-review/assignment.md", import.meta.url).pathname,
);
const BUILTIN_IMPLEMENTER_AGENT_PATH = resolvePath(
  new URL("../agents/implementer/agent.md", import.meta.url).pathname,
);

test("loadAgentConfig parses a minimal agent.md from TASK_RUNNER_CONFIG_DIR", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(configDir, "demo", MINIMAL_AGENT);

    const loaded = loadAgentConfig("demo", rootDir);
    assert.equal(loaded.config.name, "demo");
    assert.equal(loaded.config.backend, "claude");
    assert.equal(loaded.config.timeoutSec, 3600);
    assert.equal(loaded.config.unrestricted, false);
    assert.ok(!("maxRetries" in loaded.config), "maxRetries moved to assignment schema");
    assert.ok(loaded.instructions.includes("You are an assistant."));
  }));

test("loadAssignmentConfig loads authored cwd from assignment frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "explicit-cwd",
      `---
schemaVersion: 1
name: explicit-cwd
cwd: .
tasks:
  - id: t1
    title: First
---
body
`,
    );

    const loaded = loadAssignmentConfig("explicit-cwd", rootDir);
    assert.equal(loaded.config.cwd, ".");
  }));

test("loadAssignmentConfig rejects empty authored cwd after trimming", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "blank-cwd",
      `---
schemaVersion: 1
name: blank-cwd
cwd: "   "
tasks:
  - id: t1
    title: First
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("blank-cwd", rootDir), AssignmentConfigError);
  }));

test("loadAgentConfig throws AgentConfigError on bad frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "bad",
      `---
schemaVersion: 1
backend: claude
---
body
`,
    );

    assert.throws(() => loadAgentConfig("bad", rootDir), AgentConfigError);
  }));

test("loadAgentConfig silently drops `tasks` (which belongs on assignments)", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "with-tasks",
      `---
schemaVersion: 1
name: with-tasks
backend: claude
tasks:
  - id: t1
    title: First
---
body
`,
    );

    const loaded = loadAgentConfig("with-tasks", rootDir);
    assert.equal(loaded.config.name, "with-tasks");
    assert.ok(!("tasks" in loaded.config), "tasks stripped from agent config");
  }));

test("loadAgentConfig accepts agent with no tasks/vars/message fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "notasks",
      `---
schemaVersion: 1
name: notasks
backend: claude
---
body
`,
    );

    const loaded = loadAgentConfig("notasks", rootDir);
    assert.equal(loaded.config.name, "notasks");
  }));

test("loadAgentConfig accepts backendSpecific.codex.transport in agent frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "codex-transport",
      `---
schemaVersion: 1
name: codex-transport
backend: codex
backendSpecific:
  codex:
    transport:
      type: ws
      url: ws://127.0.0.1:4773/
---
body
`,
    );

    const loaded = loadAgentConfig("codex-transport", rootDir);
    assert.deepEqual(loaded.config.backendSpecific, {
      codex: {
        transport: {
          type: "ws",
          url: "ws://127.0.0.1:4773/",
        },
      },
    });
  }));

test("loadAgentConfig rejects invalid backendSpecific.codex.transport values", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "bad-transport",
      `---
schemaVersion: 1
name: bad-transport
backend: codex
backendSpecific:
  codex:
    transport:
      type: ws
      url: https://example.com/not-ws
      extra: true
---
body
`,
    );

    assert.throws(
      () => loadAgentConfig("bad-transport", rootDir),
      (err) => {
        assert.ok(err instanceof AgentConfigError);
        assert.match(err.message, /backendSpecific\.codex\.transport/);
        return true;
      },
    );
  }));

test("loadAgentConfig throws AgentNotFoundError for missing agent and lists config-root path", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    assert.throws(
      () => loadAgentConfig("nope", rootDir),
      (err) => {
        assert.ok(err instanceof AgentNotFoundError);
        assert.deepEqual(err.searched, [join(configDir, "agents", "nope", "agent.md")]);
        return true;
      },
    );
  }));

test("resolveAgentPath accepts a direct path", () => {
  const dir = tempDir();
  const agentPath = writeAgent(dir, "demo", MINIMAL_AGENT);

  const resolved = resolveAgentPath(agentPath, dir);
  assert.equal(resolved, agentPath);
});

test("loadAssignmentConfig parses a minimal assignment.md from TASK_RUNNER_CONFIG_DIR", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(configDir, "demo-work", MINIMAL_ASSIGNMENT);

    const loaded = loadAssignmentConfig("demo-work", rootDir);
    assert.equal(loaded.config.name, "demo-work");
    assert.equal(loaded.config.tasks.length, 1);
    assert.equal(loaded.config.tasks[0].id, "t1");
    assert.equal(loaded.config.maxRetries, 3, "maxRetries defaults to 3 on assignment");
    assert.ok(loaded.instructions.includes("{{assignment_path}}"));
  }));

test("built-in plan-feature assignment uses cwd instead of repo_path for canonical repo context", () => {
  const loaded = loadAssignmentConfig(BUILTIN_PLAN_FEATURE_PATH);
  assert.equal(loaded.config.vars.repo_path, undefined);
  assert.match(loaded.instructions, /`{{cwd}}`/);
  assert.ok((loaded.config.callerInstructions ?? "").includes("--assignment plan-feature"));
});

test("built-in plan-feature assignment uses same-run approval-gated delayed creation", () => {
  const loaded = loadAssignmentConfig(BUILTIN_PLAN_FEATURE_PATH);
  const callerInstructions = loaded.config.callerInstructions ?? "";
  const taskIds = loaded.config.tasks.map((task) => task.id);
  const createTask = loaded.config.tasks.find(
    (task) => task.id === "create_implementer_run_after_approval",
  );

  assert.equal(taskIds.at(-1), "create_implementer_run_after_approval");
  assert.ok(taskIds.indexOf("handoff") < taskIds.indexOf("create_implementer_run_after_approval"));
  assert.doesNotMatch(callerInstructions, /--backend passive/);
  assert.match(callerInstructions, /run --resume-run \{\{run_id\}\}/);
  assert.match(callerInstructions, /run --resume-run <new-run-id>/);
  assert.ok(createTask, "expected delayed creation approval-gate task");
  assert.match(createTask.body, /mark this task `blocked`/);
  assert.match(createTask.body, /Do \*\*not\*\* force `--backend passive`\./);
});

test("built-in plan-feature template emits implement-prefixed assignment names", () => {
  const template = readFileSync(BUILTIN_PLAN_TEMPLATE_PATH, "utf8");
  assert.match(template, /^name: implement-<<KEBAB_FEATURE_SLUG>>$/m);
  assert.doesNotMatch(template, /^name: plan-<<KEBAB_FEATURE_SLUG>>$/m);
});

test("built-in plan-feature template uses backend-accurate execution and terminal publish workflow", () => {
  const template = readFileSync(BUILTIN_PLAN_TEMPLATE_PATH, "utf8");
  assert.match(template, /run --resume-run \{\{run_id\}\}/);
  assert.match(template, /- id: push_branch_and_create_pr/);
  assert.match(template, /- id: self_check[\s\S]*- id: push_branch_and_create_pr/);
  assert.match(template, /PR URL and PR number/);
  assert.doesNotMatch(template, /final_commit/);
  assert.doesNotMatch(template, /--backend passive/);
  assert.doesNotMatch(template, /passive workflow/);
});

test("built-in plan-review assignment expects approval-gated planner handoff and publish task", () => {
  const loaded = loadAssignmentConfig(BUILTIN_PLAN_REVIEW_PATH);
  const reviewTaskStructure = loaded.config.tasks.find(
    (task) => task.id === "review_task_structure",
  );
  const reviewWorkflow = loaded.config.tasks.find(
    (task) => task.id === "review_workflow_and_handoff",
  );

  assert.ok(reviewTaskStructure, "expected review_task_structure task");
  assert.ok(reviewWorkflow, "expected review_workflow_and_handoff task");
  assert.match(reviewTaskStructure.body, /push_branch_and_create_pr/);
  assert.match(reviewWorkflow.body, /create_implementer_run_after_approval/);
  assert.match(reviewWorkflow.body, /does \*\*not\*\* hard-code\s+`--backend passive`/);
  assert.match(reviewWorkflow.body, /run --resume-run/);
  assert.match(reviewWorkflow.body, /PR URL\/number/);
});

test("built-in code-review assignment treats publish evidence as in-band plan coverage", () => {
  const loaded = loadAssignmentConfig(BUILTIN_CODE_REVIEW_PATH);
  const planCoverage = loaded.config.tasks.find((task) => task.id === "plan_coverage");

  assert.ok(planCoverage, "expected plan_coverage task");
  assert.match(
    planCoverage.body,
    /Publish work is in-band plan\s+scope, not out-of-band caller follow-up\./,
  );
  assert.match(
    planCoverage.body,
    /Any completed publish\/process task whose Notes\s+omit the required push \/ PR evidence/,
  );
});

test("built-in implementer agent points reviewers at the run record, not workspace assignment.md", () => {
  const loaded = loadAgentConfig(BUILTIN_IMPLEMENTER_AGENT_PATH);
  assert.match(loaded.instructions, /reading the run record after the fact/i);
  assert.doesNotMatch(loaded.instructions, /workspace `assignment\.md`/i);
});

test("loadAssignmentConfig throws AssignmentNotFoundError for missing assignment and lists config-root path", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    assert.throws(
      () => loadAssignmentConfig("nope-work", rootDir),
      (err) => {
        assert.ok(err instanceof AssignmentNotFoundError);
        assert.deepEqual(err.searched, [
          join(configDir, "assignments", "nope-work", "assignment.md"),
        ]);
        return true;
      },
    );
  }));

test("resolveAssignmentPath accepts a direct path", () => {
  const dir = tempDir();
  const assignmentPath = writeAssignment(dir, "demo-work", MINIMAL_ASSIGNMENT);

  const resolved = resolveAssignmentPath(assignmentPath, dir);
  assert.equal(resolved, assignmentPath);
});

test("assignment schema rejects duplicate task ids", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "dup",
      `---
schemaVersion: 1
name: dup
tasks:
  - id: t1
    title: First
  - id: t1
    title: Duplicate
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("dup", rootDir), AssignmentConfigError);
  }));

test("assignment schema rejects multiline task titles", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "multiline-title",
      `---
schemaVersion: 1
name: multiline-title
tasks:
  - id: t1
    title: |-
      Line 1
      Line 2
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("multiline-title", rootDir), AssignmentConfigError);
  }));

test("assignment schema rejects incompatible var defaults", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "bad-default",
      `---
schemaVersion: 1
name: bad-default
vars:
  retries:
    type: number
    default: nope
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("bad-default", rootDir), AssignmentConfigError);
  }));

test("loadAgentConfig does not fall back to cwd-local bare names", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(rootDir, "demo", MINIMAL_AGENT);

    assert.throws(
      () => loadAgentConfig("demo", rootDir),
      (err) => {
        assert.ok(err instanceof AgentNotFoundError);
        assert.deepEqual(err.searched, [join(configDir, "agents", "demo", "agent.md")]);
        return true;
      },
    );
  }));

test("listAgents discovers config-root agents", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAgent(configDir, "alpha", MINIMAL_AGENT);
    writeAgent(configDir, "beta", MINIMAL_AGENT);

    const entries = listAgents();
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("beta"));
    assert.equal(entries[0].root, "config");
  }));

test("listAssignments discovers config-root assignments", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAssignment(configDir, "work-a", MINIMAL_ASSIGNMENT);
    writeAssignment(configDir, "work-b", MINIMAL_ASSIGNMENT);

    const entries = listAssignments();
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("work-a"));
    assert.ok(names.includes("work-b"));
  }));

test("listAgents returns sorted names", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAgent(configDir, "zeta", MINIMAL_AGENT);
    writeAgent(configDir, "alpha", MINIMAL_AGENT);
    writeAgent(configDir, "mid", MINIMAL_AGENT);

    const entries = listAgents();
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, ["alpha", "mid", "zeta"]);
  }));

test("listAgents returns empty array when no agents exist", () =>
  withRuntimeRoots("task-runner-loader-", () => {
    const entries = listAgents();
    assert.deepEqual(entries, []);
  }));

test("listAssignments returns empty array when no assignments exist", () =>
  withRuntimeRoots("task-runner-loader-", () => {
    const entries = listAssignments();
    assert.deepEqual(entries, []);
  }));

test("listAgents skips directories without agent.md", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAgent(configDir, "real", MINIMAL_AGENT);
    mkdirSync(join(configDir, "agents", "empty"), { recursive: true });

    const entries = listAgents();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "real");
  }));

test("TASK_RUNNER_CONFIG_DIR overrides XDG_CONFIG_HOME and HOME fallbacks", () => {
  const explicitRoot = tempDir();
  const xdgRoot = tempDir();
  const homeRoot = tempDir();
  writeAgent(explicitRoot, "explicit", MINIMAL_AGENT);
  writeAgent(join(xdgRoot, "task-runner"), "xdg", MINIMAL_AGENT);
  writeAgent(join(homeRoot, ".config", "task-runner"), "home", MINIMAL_AGENT);

  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: explicitRoot,
      XDG_CONFIG_HOME: xdgRoot,
      HOME: homeRoot,
    },
    () => {
      const entries = listAgents();
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ["explicit"],
      );
    },
  );
});

test("XDG_CONFIG_HOME fallback is used when TASK_RUNNER_CONFIG_DIR is unset", () => {
  const xdgRoot = tempDir();
  const homeRoot = tempDir();
  writeAssignment(join(xdgRoot, "task-runner"), "demo-work", MINIMAL_ASSIGNMENT);

  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: xdgRoot,
      HOME: homeRoot,
    },
    () => {
      const loaded = loadAssignmentConfig("demo-work");
      assert.equal(
        loaded.sourcePath,
        join(xdgRoot, "task-runner", "assignments", "demo-work", "assignment.md"),
      );
    },
  );
});

test("HOME fallback uses ~/.config/task-runner when explicit and XDG vars are unset", () => {
  const homeRoot = tempDir();
  writeAgent(join(homeRoot, ".config", "task-runner"), "demo", MINIMAL_AGENT);

  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: undefined,
      HOME: homeRoot,
    },
    () => {
      const loaded = loadAgentConfig("demo");
      assert.equal(
        loaded.sourcePath,
        join(homeRoot, ".config", "task-runner", "agents", "demo", "agent.md"),
      );
    },
  );
});

test("listAgents throws DefinitionListError when config agents directory is unreadable", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(configDir, "visible", MINIMAL_AGENT);
    chmodSync(agentsDir, 0o000);
    try {
      assert.throws(() => listAgents(), DefinitionListError);
    } finally {
      chmodSync(agentsDir, 0o755);
    }
  }));
