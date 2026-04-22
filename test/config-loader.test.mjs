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
  LauncherConfigError,
  LauncherNotFoundError,
  listAgents,
  listAssignments,
  listLaunchers,
  loadAgentConfig,
  loadAssignmentConfig,
  loadLauncherConfig,
  resolveAgentPath,
  resolveAssignmentPath,
  resolveLauncherPath,
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

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}${ext}`);
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

test("loadAgentConfig resolves exact-match env fields and whole-body instructions", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv(
      {
        AGENT_NAME: "env-agent",
        AGENT_MODEL: "gpt-5.4",
        AGENT_TIMEOUT: "90",
        AGENT_UNRESTRICTED: "true",
        CODEX_URL: "ws://127.0.0.1:4773/socket",
        BODY_TEXT: "Operate on the release board.",
      },
      () => {
        writeAgent(
          configDir,
          "env-agent",
          `---
schemaVersion: \${AGENT_SCHEMA:-1}
name: \${AGENT_NAME}
backend: codex
model: \${AGENT_MODEL}
timeoutSec: \${AGENT_TIMEOUT}
unrestricted: \${AGENT_UNRESTRICTED}
backendSpecific:
  codex:
    transport:
      type: ws
      url: \${CODEX_URL}
---
\${BODY_TEXT}
`,
        );

        const loaded = loadAgentConfig("env-agent", rootDir);
        assert.equal(loaded.config.schemaVersion, 1);
        assert.equal(loaded.config.name, "env-agent");
        assert.equal(loaded.config.model, "gpt-5.4");
        assert.equal(loaded.config.timeoutSec, 90);
        assert.equal(loaded.config.unrestricted, true);
        assert.deepEqual(loaded.config.backendSpecific, {
          codex: {
            transport: {
              type: "ws",
              url: "ws://127.0.0.1:4773/socket",
            },
          },
        });
        assert.equal(loaded.instructions, "Operate on the release board.");
      },
    ),
  ));

test("loadAssignmentConfig resolves typed fields, whole-field prose envs, and env-backed var defaults", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv(
      {
        ASSIGNMENT_NAME: "env-work",
        ASSIGNMENT_CWD: "packages/core",
        MAX_RETRIES: "7",
        DEFAULT_RETRIES: "5",
        MESSAGE_TEXT: "Ship deployments",
        CALLER_TEXT: "Review staging first",
        DESCRIPTION_TEXT: "Uses staging",
        TASK_TITLE: "Release deployments",
        TASK_BODY: "Verify deployments",
        BODY_TEXT: "Assignment body for workspace.",
      },
      () => {
        writeAssignment(
          configDir,
          "env-work",
          `---
schemaVersion: \${ASSIGNMENT_SCHEMA:-1}
name: \${ASSIGNMENT_NAME}
cwd: \${ASSIGNMENT_CWD}
maxRetries: \${MAX_RETRIES}
message: \${MESSAGE_TEXT}
callerInstructions: \${CALLER_TEXT}
vars:
  retries:
    type: number
    default: \${DEFAULT_RETRIES}
    description: \${DESCRIPTION_TEXT}
tasks:
  - id: release
    title: \${TASK_TITLE}
    body: \${TASK_BODY}
---
\${BODY_TEXT}
`,
        );

        const loaded = loadAssignmentConfig("env-work", rootDir);
        assert.equal(loaded.config.schemaVersion, 1);
        assert.equal(loaded.config.name, "env-work");
        assert.equal(loaded.config.cwd, "packages/core");
        assert.equal(loaded.config.maxRetries, 7);
        assert.equal(loaded.config.message, "Ship deployments");
        assert.equal(loaded.config.callerInstructions, "Review staging first");
        assert.equal(loaded.config.vars.retries.default, "5");
        assert.equal(loaded.config.vars.retries.description, "Uses staging");
        assert.equal(loaded.config.tasks[0].title, "Release deployments");
        assert.equal(loaded.config.tasks[0].body, "Verify deployments");
        assert.equal(loaded.instructions, "Assignment body for workspace.");
      },
    ),
  ));

test("loadAssignmentConfig accepts hooks and vars.requiredAt", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "hooked-work",
      `---
schemaVersion: 1
name: hooked-work
vars:
  worktree_path:
    type: string
    required: true
    requiredAt: prepare
hooks:
  prepare:
    - name: named-prepare
      with:
        path: "{{cwd}}/prepared"
  taskTransition:
    - path: ./hooks/guard.mts
      when:
        toStatus: ["completed"]
---
body
`,
    );

    const loaded = loadAssignmentConfig("hooked-work", rootDir);
    assert.equal(loaded.config.vars.worktree_path.requiredAt, "prepare");
    assert.equal(loaded.config.hooks.prepare.length, 1);
    assert.equal(loaded.config.hooks.prepare[0].name, "named-prepare");
    assert.equal(loaded.config.hooks.taskTransition[0].path, "./hooks/guard.mts");
  }));

test("loadAssignmentConfig leaves partial env syntax literal in prose surfaces", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv(
      {
        TARGET_BRANCH: "main",
        ENVIRONMENT: "staging",
        BODY_TEXT: "Use ${TASK_RUNNER_CONFIG_DIR} when debugging.",
      },
      () => {
        writeAssignment(
          configDir,
          "literal-prose",
          `---
schemaVersion: 1
name: literal-prose
message: Review \${TARGET_BRANCH} before shipping
callerInstructions: Check \${ENVIRONMENT} first
tasks:
  - id: review
    title: Review \${TARGET_BRANCH}
    body: Validate \${ENVIRONMENT} before merge.
vars:
  target:
    type: string
    default: main
    description: Uses \${ENVIRONMENT}
---
\${BODY_TEXT}
`,
        );

        const loaded = loadAssignmentConfig("literal-prose", rootDir);
        assert.equal(loaded.config.message, "Review ${TARGET_BRANCH} before shipping");
        assert.equal(loaded.config.callerInstructions, "Check ${ENVIRONMENT} first");
        assert.equal(loaded.config.tasks[0].title, "Review ${TARGET_BRANCH}");
        assert.equal(loaded.config.tasks[0].body, "Validate ${ENVIRONMENT} before merge.");
        assert.equal(loaded.config.vars.target.description, "Uses ${ENVIRONMENT}");
        assert.equal(loaded.instructions, "Use ${TASK_RUNNER_CONFIG_DIR} when debugging.");
      },
    ),
  ));

test("loadAssignmentConfig rejects hook entries without exactly one source selector", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "bad-hook-work",
      `---
schemaVersion: 1
name: bad-hook-work
hooks:
  prepare:
    - builtin: command
      name: duplicate
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("bad-hook-work", rootDir), AssignmentConfigError);
  }));

for (const { name, expression, envValue, expected } of [
  {
    name: "exact env field uses the current value when set",
    expression: "${RETRIES}",
    envValue: "4",
    expected: 4,
  },
  {
    name: ":- fallback uses the env value when non-empty",
    expression: "${RETRIES:-6}",
    envValue: "9",
    expected: 9,
  },
  {
    name: ":- fallback uses the fallback when env is unset",
    expression: "${RETRIES:-6}",
    envValue: undefined,
    expected: 6,
  },
  {
    name: ":- fallback uses the fallback when env is empty",
    expression: "${RETRIES:-6}",
    envValue: "",
    expected: 6,
  },
  {
    name: "- fallback uses the fallback when env is unset",
    expression: "${RETRIES-6}",
    envValue: undefined,
    expected: 6,
  },
]) {
  test(`loadAssignmentConfig ${name}`, () =>
    withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
      withEnv({ RETRIES: envValue }, () => {
        writeAssignment(
          configDir,
          "fallbacks",
          `---
schemaVersion: 1
name: fallbacks
maxRetries: ${expression}
---
body
`,
        );

        const loaded = loadAssignmentConfig("fallbacks", rootDir);
        assert.equal(loaded.config.maxRetries, expected);
      }),
    ));
}

test("loadAssignmentConfig treats an empty env value as empty for - fallback exact fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ RETRIES: "" }, () => {
      writeAssignment(
        configDir,
        "dash-empty",
        `---
schemaVersion: 1
name: dash-empty
maxRetries: \${RETRIES-6}
---
body
`,
      );

      assert.throws(
        () => loadAssignmentConfig("dash-empty", rootDir),
        (err) => {
          assert.ok(err instanceof AssignmentConfigError);
          assert.match(err.message, /assignment\.maxRetries/);
          assert.match(err.message, /RETRIES/);
          assert.match(err.message, /empty/);
          return true;
        },
      );
    }),
  ));

test("loadAssignmentConfig rejects missing required exact env fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ RETRIES: undefined }, () => {
      writeAssignment(
        configDir,
        "missing-env",
        `---
schemaVersion: 1
name: missing-env
maxRetries: \${RETRIES}
---
body
`,
      );

      assert.throws(
        () => loadAssignmentConfig("missing-env", rootDir),
        (err) => {
          assert.ok(err instanceof AssignmentConfigError);
          assert.match(err.message, /assignment\.maxRetries/);
          assert.match(err.message, /RETRIES/);
          assert.match(err.message, /missing/);
          return true;
        },
      );
    }),
  ));

test("loadAssignmentConfig rejects empty required exact env fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ RETRIES: "" }, () => {
      writeAssignment(
        configDir,
        "empty-env",
        `---
schemaVersion: 1
name: empty-env
maxRetries: \${RETRIES}
---
body
`,
      );

      assert.throws(
        () => loadAssignmentConfig("empty-env", rootDir),
        (err) => {
          assert.ok(err instanceof AssignmentConfigError);
          assert.match(err.message, /assignment\.maxRetries/);
          assert.match(err.message, /RETRIES/);
          assert.match(err.message, /empty/);
          return true;
        },
      );
    }),
  ));

test("loadAgentConfig rejects invalid number coercion for exact env fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ AGENT_TIMEOUT: "abc" }, () => {
      writeAgent(
        configDir,
        "bad-timeout",
        `---
schemaVersion: 1
name: bad-timeout
backend: claude
timeoutSec: \${AGENT_TIMEOUT}
---
body
`,
      );

      assert.throws(
        () => loadAgentConfig("bad-timeout", rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /agent\.timeoutSec/);
          assert.match(err.message, /AGENT_TIMEOUT/);
          assert.match(err.message, /not a valid number/);
          return true;
        },
      );
    }),
  ));

test("loadAgentConfig rejects invalid boolean coercion for exact env fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ AGENT_FLAG: "yes" }, () => {
      writeAgent(
        configDir,
        "bad-flag",
        `---
schemaVersion: 1
name: bad-flag
backend: claude
unrestricted: \${AGENT_FLAG}
---
body
`,
      );

      assert.throws(
        () => loadAgentConfig("bad-flag", rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /agent\.unrestricted/);
          assert.match(err.message, /AGENT_FLAG/);
          assert.match(err.message, /not a valid boolean/);
          return true;
        },
      );
    }),
  ));

test("loadAgentConfig rejects partial interpolation in exact-only fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ AGENT_NAME: "demo" }, () => {
      writeAgent(
        configDir,
        "partial-exact",
        `---
schemaVersion: 1
name: agent-\${AGENT_NAME}
backend: claude
---
body
`,
      );

      assert.throws(
        () => loadAgentConfig("partial-exact", rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /agent\.name/);
          assert.match(err.message, /AGENT_NAME/);
          assert.match(err.message, /mismatch with field surface/);
          return true;
        },
      );
    }),
  ));

test("loadAgentConfig reports invalid env syntax with path context", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "invalid-syntax",
      `---
schemaVersion: 1
name: \${BROKEN
backend: claude
---
body
`,
    );

    assert.throws(
      () => loadAgentConfig("invalid-syntax", rootDir),
      (err) => {
        assert.ok(err instanceof AgentConfigError);
        assert.match(err.message, /agent\.name/);
        assert.match(err.message, /BROKEN/);
        assert.match(err.message, /invalid syntax/);
        return true;
      },
    );
  }));

for (const { name, writer, load, id, expectedPath, expectedEnv } of [
  {
    name: "loadAgentConfig rejects env blob replacement for backendSpecific",
    writer: (configDir) =>
      writeAgent(
        configDir,
        "blob-agent",
        `---
schemaVersion: 1
name: blob-agent
backend: codex
backendSpecific: \${CODEX_SETTINGS}
---
body
`,
      ),
    load: loadAgentConfig,
    id: "blob-agent",
    expectedPath: /agent\.backendSpecific/,
    expectedEnv: /CODEX_SETTINGS/,
  },
  {
    name: "loadAssignmentConfig rejects env blob replacement for tasks",
    writer: (configDir) =>
      writeAssignment(
        configDir,
        "blob-tasks",
        `---
schemaVersion: 1
name: blob-tasks
tasks: \${TASKS}
---
body
`,
      ),
    load: loadAssignmentConfig,
    id: "blob-tasks",
    expectedPath: /assignment\.tasks/,
    expectedEnv: /TASKS/,
  },
  {
    name: "loadAssignmentConfig rejects env blob replacement for lockedFields",
    writer: (configDir) =>
      writeAssignment(
        configDir,
        "blob-locks",
        `---
schemaVersion: 1
name: blob-locks
lockedFields: \${LOCKS}
---
body
`,
      ),
    load: loadAssignmentConfig,
    id: "blob-locks",
    expectedPath: /assignment\.lockedFields/,
    expectedEnv: /LOCKS/,
  },
]) {
  test(name, () =>
    withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
      withEnv(
        {
          CODEX_SETTINGS: '{"codex":{"transport":{"type":"ws","url":"ws://127.0.0.1:4773/"}}}',
          TASKS: '[{"id":"t1","title":"Injected"}]',
          LOCKS: '["backend"]',
        },
        () => {
          writer(configDir);

          assert.throws(
            () => load(id, rootDir),
            (err) => {
              const expectedClass =
                load === loadAgentConfig ? AgentConfigError : AssignmentConfigError;
              assert.ok(err instanceof expectedClass);
              assert.match(err.message, expectedPath);
              assert.match(err.message, expectedEnv);
              assert.match(err.message, /mismatch with field surface/);
              return true;
            },
          );
        },
      ),
    ));
}

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
  assert.deepEqual(loaded.config.vars.worktree_slug?.sources, ["cli"]);
  assert.equal(loaded.config.hooks.prepare[0]?.path, "hooks/derive-worktree-vars.ts");
  assert.match(loaded.instructions, /`{{cwd}}`/);
  assert.ok((loaded.config.callerInstructions ?? "").includes("--assignment plan-feature"));
  assert.match(loaded.config.callerInstructions ?? "", /--var worktree_slug=<git-safe-slug>/);

  const taskIds = loaded.config.tasks.map((task) => task.id);
  assert.ok(taskIds.includes("create_initialized_implementer_run"));

  const createTask = loaded.config.tasks.find(
    (task) => task.id === "create_initialized_implementer_run",
  );
  assert.ok(createTask);
  assert.match(createTask.body ?? "", /--agent implementer/);
  assert.doesNotMatch(
    createTask.body ?? "",
    /Always use `--agent implementer --backend passive`|--agent implementer \\\n\s+--backend passive/,
  );
  assert.match(
    createTask.body ?? "",
    /resulting implementer run is left in\s+`initialized`, not `ready`/,
  );
  assert.match(createTask.body ?? "", /--run-id <existing-implementer-run-id>/);
  assert.doesNotMatch(createTask.body ?? "", /--cwd <confirmed-worktree-dir>/);
  assert.match(createTask.body ?? "", /cwd: "\{\{worktree_path\}\}"/);
  assert.match(
    createTask.body ?? "",
    /Do not assume updating the draft file or refreshing the\s+planning-run attachments alone updates the implementer\s+run/i,
  );
  assert.match(createTask.body ?? "", /run ready <new-run-id>/);
  assert.match(createTask.body ?? "", /run --resume-run <new-run-id>/);

  assert.match(loaded.config.callerInstructions ?? "", /run ready <new-run-id>/);
  assert.match(loaded.config.callerInstructions ?? "", /run --resume-run <new-run-id>/);
  assert.match(
    loaded.config.callerInstructions ?? "",
    /reinitialize the same initialized\s+implementer run from the updated draft/i,
  );
  assert.doesNotMatch(loaded.config.callerInstructions ?? "", /passive backend/i);
});

test("built-in plan-feature template emits implement-prefixed assignment names", () => {
  const template = readFileSync(BUILTIN_PLAN_TEMPLATE_PATH, "utf8");
  assert.match(template, /^name: implement-<<KEBAB_FEATURE_SLUG>>$/m);
  assert.doesNotMatch(template, /^name: plan-<<KEBAB_FEATURE_SLUG>>$/m);
  assert.match(template, /^cwd: "\{\{repo_root\}\}"$/m);
  assert.match(template, /sources: \[parent\]/);
  assert.match(template, /builtin: git-worktree/);
  assert.match(template, /attemptInSession: \[0\]/);
  assert.match(template, /collision: reuse/);
  assert.match(template, /run ready {{run_id}}/);
  assert.match(template, /run --resume-run {{run_id}}/);
  assert.doesNotMatch(template, /passive backend/i);
  assert.match(template, /- id: push_branch_and_create_pr/);
  assert.doesNotMatch(template, /- id: final_commit/);
});

test("built-in plan-review tracks immediate-init revision handoff and terminal publish workflow", () => {
  const loaded = loadAssignmentConfig(BUILTIN_PLAN_REVIEW_PATH);
  const structureTask = loaded.config.tasks.find((task) => task.id === "review_task_structure");
  const workflowTask = loaded.config.tasks.find(
    (task) => task.id === "review_workflow_and_handoff",
  );

  assert.ok(structureTask);
  assert.ok(workflowTask);
  assert.match(structureTask.body ?? "", /push_branch_and_create_pr/);
  assert.doesNotMatch(structureTask.body ?? "", /final_commit/);
  assert.match(workflowTask.body ?? "", /creates the implementer run during the/);
  assert.match(workflowTask.body ?? "", /does \*\*not\*\* force/);
  assert.match(workflowTask.body ?? "", /repo_root`, `worktree_slug`, and `worktree_path` vars/);
  assert.match(workflowTask.body ?? "", /`cwd: "\{\{repo_root\}\}"`/);
  assert.match(workflowTask.body ?? "", /refresh the planning run's/);
  assert.match(workflowTask.body ?? "", /init --run-id <implementer-run-id>/);
  assert.match(workflowTask.body ?? "", /run ready/);
  assert.match(workflowTask.body ?? "", /run --resume-run/);
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

test("loadAgentConfig normalizes named, path, and inline launcher authoring", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeLauncher(
      configDir,
      "ssh-docker",
      `schemaVersion: 1
command: ssh
args:
  - buildbox
  - docker
  - exec
  - worker
  - --
`,
    );
    const launcherPath = join(rootDir, "one-off.yaml");
    writeFileSync(
      launcherPath,
      `schemaVersion: 1
command: env
args: [FOO=bar]
`,
    );
    writeAgent(
      configDir,
      "named-launchers",
      `---
schemaVersion: 1
name: named-launchers
backend: claude
launcher: ssh-docker
---
body
`,
    );
    writeAgent(
      configDir,
      "path-launcher",
      `---
schemaVersion: 1
name: path-launcher
backend: claude
launcher: ../../../one-off.yaml
---
body
`,
    );
    writeAgent(
      configDir,
      "inline-launcher",
      `---
schemaVersion: 1
name: inline-launcher
backend: claude
launcher:
  command: ssh
  args: [buildbox, docker, exec, worker, --]
---
body
`,
    );

    assert.deepEqual(loadAgentConfig("named-launchers", rootDir).launcher, {
      kind: "name",
      ref: "ssh-docker",
      name: "ssh-docker",
    });
    assert.deepEqual(loadAgentConfig("path-launcher", rootDir).launcher, {
      kind: "path",
      ref: "../../../one-off.yaml",
      path: launcherPath,
    });
    assert.deepEqual(loadAgentConfig("inline-launcher", rootDir).launcher, {
      kind: "inline",
      config: {
        command: "ssh",
        args: ["buildbox", "docker", "exec", "worker", "--"],
      },
    });
  }));

test("loadAgentConfig rejects empty launcher strings at schema validation time", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "blank-launcher",
      `---
schemaVersion: 1
name: blank-launcher
backend: claude
launcher: ""
---
body
`,
    );

    assert.throws(
      () => loadAgentConfig("blank-launcher", rootDir),
      (error) => {
        assert.ok(error instanceof AgentConfigError);
        assert.match(error.message, /launcher/i);
        return true;
      },
    );
  }));

test("listLaunchers returns direct plus valid named launchers and skips invalid files with warnings", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeLauncher(
      configDir,
      "ssh-docker",
      `schemaVersion: 1
command: ssh
args: [worker]
`,
    );
    writeLauncher(
      configDir,
      "mismatch",
      `schemaVersion: 1
name: different
command: ssh
`,
    );
    writeLauncher(
      configDir,
      "direct",
      `schemaVersion: 1
command: ssh
`,
      ".yml",
    );
    writeLauncher(
      configDir,
      "broken",
      `schemaVersion: not-a-number
command:
`,
    );

    const result = listLaunchers();
    assert.deepEqual(
      result.entries.map((entry) => ({ name: entry.name, root: entry.root })),
      [
        { name: "direct", root: "builtin" },
        { name: "ssh-docker", root: "config" },
      ],
    );
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings[0], /Invalid launcher config/);
    assert.match(result.warnings.join("\n"), /built-in direct launcher/);
    assert.match(result.warnings.join("\n"), /must match launcher file id/);
  }));

test("loadLauncherConfig supports direct, named files, and targeted path loads", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    const path = writeLauncher(
      configDir,
      "ssh-docker",
      `schemaVersion: 1
name: ssh-docker
command: ssh
args: [worker]
`,
    );

    assert.deepEqual(loadLauncherConfig("direct", rootDir), {
      kind: "direct",
      name: "direct",
      sourcePath: null,
      root: "builtin",
    });
    assert.deepEqual(loadLauncherConfig("ssh-docker", rootDir), {
      kind: "prefix",
      name: "ssh-docker",
      command: "ssh",
      args: ["worker"],
      sourcePath: path,
      root: "config",
      config: {
        schemaVersion: 1,
        name: "ssh-docker",
        command: "ssh",
        args: ["worker"],
      },
    });
    assert.equal(resolveLauncherPath("ssh-docker", rootDir), path);
    assert.equal(loadLauncherConfig(path, rootDir).sourcePath, path);
  }));

test("loadLauncherConfig hard-fails targeted invalid paths and named invalid launchers remain undiscoverable", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    const mismatchPath = writeLauncher(
      configDir,
      "bad-name",
      `schemaVersion: 1
name: other-name
command: ssh
`,
    );

    assert.throws(
      () => loadLauncherConfig(mismatchPath, rootDir),
      (error) => {
        assert.ok(error instanceof LauncherConfigError);
        assert.match(error.message, /must match launcher file id/);
        return true;
      },
    );
    assert.throws(
      () => loadLauncherConfig("bad-name", rootDir),
      (error) => {
        assert.ok(error instanceof LauncherNotFoundError);
        return true;
      },
    );
  }));

test("listLaunchers throws DefinitionListError when launcher root is unreadable", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    const launchersDir = join(configDir, "launchers");
    mkdirSync(launchersDir, { recursive: true });
    writeLauncher(
      configDir,
      "visible",
      `schemaVersion: 1
command: ssh
`,
    );
    chmodSync(launchersDir, 0o000);
    try {
      assert.throws(() => listLaunchers(), DefinitionListError);
    } finally {
      chmodSync(launchersDir, 0o755);
    }
  }));

test("listLaunchers warn-skips unreadable launcher files", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    const unreadablePath = writeLauncher(
      configDir,
      "cant-read",
      `schemaVersion: 1
command: ssh
`,
    );
    chmodSync(unreadablePath, 0o000);
    try {
      const result = listLaunchers();
      assert.deepEqual(
        result.entries.map((entry) => entry.name),
        ["direct"],
      );
      assert.match(result.warnings.join("\n"), /cant-read\.yaml/);
    } finally {
      chmodSync(unreadablePath, 0o644);
    }
  }));
