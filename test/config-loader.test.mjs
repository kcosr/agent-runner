import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
  LauncherConfigError,
  LauncherNotFoundError,
  listAgentDefinitions,
  listAgents,
  listAssignmentDefinitions,
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
name: __NAME__
backend: claude
---
You are an assistant.
`;

const MINIMAL_ASSIGNMENT = `---
schemaVersion: 1
name: __NAME__
tasks:
  - id: t1
    title: Do the thing
    body: First thing to do.
---
Work on the repo. Plan at {{cwd}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-loader-extra-"));
}

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "agent.md");
  writeFileSync(path, body.replace("__NAME__", name));
  return path;
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "assignment.md");
  writeFileSync(path, body.replace("__NAME__", name));
  return path;
}

function writeTask(baseDir, name, body) {
  const path = join(baseDir, "tasks", `${name}.md`);
  mkdirSync(dirname(path), { recursive: true });
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
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const BUILTIN_PLAN_TEMPLATE_PATH = resolvePath(
  new URL("../assignments/plan-feature/template.md", import.meta.url).pathname,
);
const BUILTIN_PLAN_REVIEW_PATH = resolvePath(
  new URL("../assignments/plan-review/assignment.md", import.meta.url).pathname,
);
const BUILTIN_CODE_REVIEW_PATH = resolvePath(
  new URL("../assignments/code-review/assignment.md", import.meta.url).pathname,
);
const BUILTIN_CODE_REVIEW_DIRECT_PATH = resolvePath(
  new URL("../assignments/code-review-direct/assignment.md", import.meta.url).pathname,
);
const BUILTIN_IMPLEMENTER_AGENT_PATH = resolvePath(
  new URL("../agents/implementer/agent.md", import.meta.url).pathname,
);

const SHARED_REVIEW_TASK_IDS = [
  "review/architecture",
  "review/concurrency",
  "review/error-handling",
  "review/state-machine",
  "review/resources",
  "review/security",
  "review/types-schema",
  "review/simplification-and-duplication",
  "review/test-coverage",
  "review/docs-drift",
];

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
        CODEX_UDS_PATH: "/tmp/codex.sock",
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
      type: uds
      path: \${CODEX_UDS_PATH}
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
              type: "uds",
              path: "/tmp/codex.sock",
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
        SCHEDULE_CRON: "*/5 * * * *",
        SCHEDULE_TZ: "UTC",
        SCHEDULE_CONTINUE: "true",
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
schedule:
  cron: \${SCHEDULE_CRON}
  timezone: \${SCHEDULE_TZ}
  mode: reuse
  continueOnFailure: \${SCHEDULE_CONTINUE}
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
        assert.deepEqual(loaded.config.schedule, {
          cron: "*/5 * * * *",
          timezone: "UTC",
          mode: "reuse",
          continueOnFailure: true,
        });
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

test("loadAssignmentConfig rejects invalid schedule field combinations", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "bad-schedule",
      `---
schemaVersion: 1
name: bad-schedule
schedule:
  at: "2026-04-25T00:10:00.000Z"
  timezone: UTC
---
body
`,
    );

    assert.throws(
      () => loadAssignmentConfig("bad-schedule", rootDir),
      (err) => {
        assert.ok(err instanceof AssignmentConfigError);
        assert.match(err.message, /schedule\.timezone/);
        assert.match(err.message, /valid only with `cron`/);
        return true;
      },
    );
  }));

test("loadAssignmentConfig accepts schedule as a lockable field", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "locked-schedule",
      `---
schemaVersion: 1
name: locked-schedule
lockedFields: [schedule]
schedule:
  delay: 30m
---
body
`,
    );

    const loaded = loadAssignmentConfig("locked-schedule", rootDir);

    assert.deepEqual(loaded.config.lockedFields, ["schedule"]);
    assert.deepEqual(loaded.config.schedule, { delay: "30m" });
  }));

test("loadAssignmentConfig accepts task-local task-transition hooks", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "task-local-hooks",
      `---
schemaVersion: 1
name: task-local-hooks
tasks:
  - id: review
    title: Review
    hooks:
      - builtin: require-children-success
        with:
          requireAny: true
---
body
`,
    );

    const loaded = loadAssignmentConfig("task-local-hooks", rootDir);
    assert.equal(loaded.config.tasks[0]?.hooks.length, 1);
    assert.equal(loaded.config.tasks[0]?.hooks[0]?.builtin, "require-children-success");
    assert.equal(loaded.config.tasks[0]?.hooks[0]?.with?.requireAny, true);
  }));

test("loadAssignmentConfig rejects invalid task-transition when clauses", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "bad-task-transition-when",
      `---
schemaVersion: 1
name: bad-task-transition-when
hooks:
  taskTransition:
    - builtin: require-children-success
      when:
        taskId: review
        taskIds: [review]
tasks:
  - id: review
    title: Review
---
body
`,
    );

    assert.throws(
      () => loadAssignmentConfig("bad-task-transition-when", rootDir),
      AssignmentConfigError,
    );
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
    name: "loadAssignmentConfig rejects env blob replacement for schedule",
    writer: (configDir) =>
      writeAssignment(
        configDir,
        "blob-schedule",
        `---
schemaVersion: 1
name: blob-schedule
schedule: \${SCHEDULE}
---
body
`,
      ),
    load: loadAssignmentConfig,
    id: "blob-schedule",
    expectedPath: /assignment\.schedule/,
    expectedEnv: /SCHEDULE/,
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
          SCHEDULE: '{"delay":"30m"}',
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

test("loadAgentConfig accepts UDS backendSpecific.codex.transport in agent frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "codex-uds-transport",
      `---
schemaVersion: 1
name: codex-uds-transport
backend: codex
backendSpecific:
  codex:
    transport:
      type: uds
      path: /tmp/codex.sock
---
body
`,
    );

    const loaded = loadAgentConfig("codex-uds-transport", rootDir);
    assert.deepEqual(loaded.config.backendSpecific, {
      codex: {
        transport: {
          type: "uds",
          path: "/tmp/codex.sock",
        },
      },
    });
  }));

test("loadAgentConfig accepts backendArgs entries for multiple backends", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "backend-args",
      `---
schemaVersion: 1
name: backend-args
backend: claude
backendArgs:
  claude:
    extraArgs:
      - --model
      - opus
  codex:
    extraArgs:
      - --experimental-codex-flag
  passive:
    extraArgs:
      - --accepted-but-inert
---
body
`,
    );

    const loaded = loadAgentConfig("backend-args", rootDir);
    assert.deepEqual(loaded.config.backendArgs, {
      claude: { extraArgs: ["--model", "opus"] },
      codex: { extraArgs: ["--experimental-codex-flag"] },
      passive: { extraArgs: ["--accepted-but-inert"] },
    });
  }));

test("loadAgentConfig rejects malformed backendArgs values", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    for (const [name, backendArgs, pattern] of [
      ["unknown-key", "gemini:\n    extraArgs: [--flag]", /backendArgs/],
      ["missing-extra-args", "claude: {}", /backendArgs\.claude\.extraArgs/],
      ["extra-field", "claude:\n    extraArgs: [--flag]\n    env: {}", /backendArgs\.claude/],
      ["non-array", "claude:\n    extraArgs: --flag", /backendArgs\.claude\.extraArgs/],
      ["empty-token", 'claude:\n    extraArgs: [""]', /extraArgs entries must be non-empty/],
      ["blank-token", 'claude:\n    extraArgs: ["   "]', /extraArgs entries must be non-empty/],
    ]) {
      writeAgent(
        configDir,
        name,
        `---
schemaVersion: 1
name: ${name}
backend: claude
backendArgs:
  ${backendArgs}
---
body
`,
      );

      assert.throws(
        () => loadAgentConfig(name, rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, pattern);
          return true;
        },
      );
    }
  }));

test("loadAgentConfig applies exact env interpolation to backendArgs tokens only", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ BACKEND_FLAG: "--from-env", FLAG_VALUE: "value" }, () => {
      writeAgent(
        configDir,
        "backend-args-env",
        `---
schemaVersion: 1
name: backend-args-env
backend: cursor
backendArgs:
  cursor:
    extraArgs:
      - \${BACKEND_FLAG}
      - \${FLAG_VALUE}
---
body
`,
      );
      assert.deepEqual(loadAgentConfig("backend-args-env", rootDir).config.backendArgs, {
        cursor: { extraArgs: ["--from-env", "value"] },
      });

      writeAgent(
        configDir,
        "backend-args-partial-env",
        `---
schemaVersion: 1
name: backend-args-partial-env
backend: cursor
backendArgs:
  cursor:
    extraArgs:
      - --flag=\${FLAG_VALUE}
---
body
`,
      );
      assert.throws(
        () => loadAgentConfig("backend-args-partial-env", rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /agent\.backendArgs\.cursor\.extraArgs\[0\]/);
          assert.match(err.message, /mismatch with field surface/);
          return true;
        },
      );

      writeAgent(
        configDir,
        "backend-args-blob-env",
        `---
schemaVersion: 1
name: backend-args-blob-env
backend: cursor
backendArgs: \${BACKEND_ARGS}
---
body
`,
      );
      assert.throws(
        () => loadAgentConfig("backend-args-blob-env", rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /agent\.backendArgs/);
          assert.match(err.message, /mismatch with field surface/);
          return true;
        },
      );
    }),
  ));

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

test("loadAgentConfig rejects invalid UDS backendSpecific.codex.transport values", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    for (const [name, path] of [
      ["relative-uds", "tmp/codex.sock"],
      ["home-uds", "~/codex.sock"],
      ["unix-url-uds", "unix:///tmp/codex.sock"],
    ]) {
      writeAgent(
        configDir,
        name,
        `---
schemaVersion: 1
name: ${name}
backend: codex
backendSpecific:
  codex:
    transport:
      type: uds
      path: ${path}
---
body
`,
      );

      assert.throws(
        () => loadAgentConfig(name, rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /backendSpecific\.codex\.transport/);
          assert.match(err.message, /absolute socket path/);
          return true;
        },
      );
    }

    writeAgent(
      configDir,
      "extra-uds",
      `---
schemaVersion: 1
name: extra-uds
backend: codex
backendSpecific:
  codex:
    transport:
      type: uds
      path: /tmp/codex.sock
      url: ws://127.0.0.1:4773/
---
body
`,
    );

    assert.throws(
      () => loadAgentConfig("extra-uds", rootDir),
      (err) => {
        assert.ok(err instanceof AgentConfigError);
        assert.match(err.message, /backendSpecific\.codex\.transport/);
        assert.match(err.message, /Unrecognized key/);
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

test("direct agent paths outside the config root may use authored names", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir }) => {
    const dir = join(rootDir, "external-agents", "worker");
    mkdirSync(dir, { recursive: true });
    const agentPath = join(dir, "agent.md");
    writeFileSync(
      agentPath,
      `---
schemaVersion: 1
name: direct-worker
backend: claude
---
External direct-path agent.
`,
    );

    const loaded = loadAgentConfig(agentPath, rootDir);
    assert.equal(loaded.config.name, "direct-worker");
  }));

test("loadAssignmentConfig parses a minimal assignment.md from TASK_RUNNER_CONFIG_DIR", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(configDir, "demo-work", MINIMAL_ASSIGNMENT);

    const loaded = loadAssignmentConfig("demo-work", rootDir);
    assert.equal(loaded.config.name, "demo-work");
    assert.equal(loaded.config.tasks.length, 1);
    assert.equal(loaded.config.tasks[0].id, "t1");
    assert.equal(loaded.config.maxRetries, 3, "maxRetries defaults to 3 on assignment");
    assert.ok(loaded.instructions.includes("{{cwd}}"));
  }));

test("loadAssignmentConfig resolves named and explicit task refs into plain task objects", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeTask(
      configDir,
      "orient",
      `---
schemaVersion: 1
title: Orient repo
---
Read README.md.
`,
    );
    writeTask(
      configDir,
      "review/reuse",
      `---
schemaVersion: 1
id: review/reuse
title: Reuse pass
---
Check reusable pieces.
`,
    );
    const assignmentDir = join(configDir, "assignments", "mixed-refs");
    mkdirSync(join(assignmentDir, "local"), { recursive: true });
    const localTaskPath = join(assignmentDir, "local", "checklist.md");
    writeFileSync(
      localTaskPath,
      `---
schemaVersion: 1
title: Relative checklist
---
Review local checklist.
`,
    );
    const absoluteTaskPath = join(rootDir, "absolute-task.md");
    writeFileSync(
      absoluteTaskPath,
      `---
schemaVersion: 1
title: Absolute checklist
---
Review absolute checklist.
`,
    );
    writeAssignment(
      configDir,
      "mixed-refs",
      `---
schemaVersion: 1
name: mixed-refs
tasks:
  - orient
  - review/reuse
  - ./local/checklist.md
  - ${absoluteTaskPath}
  - id: inline-task
    title: Inline task
    body: Inline body
---
Assignment body.
`,
    );

    const loaded = loadAssignmentConfig("mixed-refs", rootDir);
    assert.deepEqual(
      loaded.config.tasks.map((task) => ({ id: task.id, title: task.title, body: task.body })),
      [
        { id: "orient", title: "Orient repo", body: "Read README.md." },
        { id: "review/reuse", title: "Reuse pass", body: "Check reusable pieces." },
        { id: "checklist", title: "Relative checklist", body: "Review local checklist." },
        { id: "absolute-task", title: "Absolute checklist", body: "Review absolute checklist." },
        { id: "inline-task", title: "Inline task", body: "Inline body" },
      ],
    );
  }));

test("loadAssignmentConfig hard-fails when a referenced task id mismatches its canonical file id", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeTask(
      configDir,
      "review/reuse",
      `---
schemaVersion: 1
id: review/wrong
title: Reuse pass
---
Check reusable pieces.
`,
    );
    writeAssignment(
      configDir,
      "task-mismatch",
      `---
schemaVersion: 1
name: task-mismatch
tasks:
  - review/reuse
---
Assignment body.
`,
    );

    assert.throws(
      () => loadAssignmentConfig("task-mismatch", rootDir),
      (error) => {
        assert.ok(error instanceof AssignmentConfigError);
        assert.match(error.message, /tasks\[0\]/);
        assert.match(error.message, /review\/reuse/);
        assert.match(error.message, /must match canonical id "review\/reuse"/);
        return true;
      },
    );
  }));

test("direct task paths outside the config root may use authored ids", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    const externalTaskPath = join(rootDir, "external-tasks", "review", "reuse.md");
    mkdirSync(dirname(externalTaskPath), { recursive: true });
    writeFileSync(
      externalTaskPath,
      `---
schemaVersion: 1
id: review/reuse
title: External reuse pass
---
Check external reusable pieces.
`,
    );
    writeAssignment(
      configDir,
      "external-task-ref",
      `---
schemaVersion: 1
name: external-task-ref
tasks:
  - ${externalTaskPath}
---
Assignment body.
`,
    );

    const loaded = loadAssignmentConfig("external-task-ref", rootDir);
    assert.equal(loaded.config.tasks[0].id, "review/reuse");
    assert.equal(loaded.config.tasks[0].title, "External reuse pass");
  }));

test("built-in shared review task files are valid config-root named task definitions", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeTask(
      configDir,
      "review/architecture",
      readFileSync(new URL("../tasks/review/architecture.md", import.meta.url), "utf8"),
    );
    writeAssignment(
      configDir,
      "uses-shared-review-task",
      `---
schemaVersion: 1
name: uses-shared-review-task
tasks:
  - review/architecture
---
Assignment body.
`,
    );

    const loaded = loadAssignmentConfig("uses-shared-review-task", rootDir);
    assert.equal(loaded.config.tasks[0].id, "review/architecture");
    assert.equal(loaded.config.tasks[0].title, "Architecture & module boundaries");
    assert.match(loaded.config.tasks[0].body, /Review the module layout/);
    assert.match(loaded.config.tasks[0].body, /review\/simplification-and-duplication/);
  }));

test("loadAssignmentConfig hard-fails when a referenced named task is missing", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "missing-task",
      `---
schemaVersion: 1
name: missing-task
tasks:
  - does/not/exist
---
Assignment body.
`,
    );

    assert.throws(
      () => loadAssignmentConfig("missing-task", rootDir),
      (error) => {
        assert.ok(error instanceof AssignmentConfigError);
        assert.match(error.message, /does\/not\/exist/);
        assert.match(error.message, /task reference/);
        return true;
      },
    );
  }));

test("built-in code-review assignment resolves shared review tasks and preserves implementation-run gates", () =>
  withEnv({ TASK_RUNNER_CONFIG_DIR: REPO_ROOT }, () => {
    const loaded = loadAssignmentConfig(BUILTIN_CODE_REVIEW_PATH);

    assert.deepEqual(
      loaded.config.tasks.map((task) => task.id),
      ["orient", ...SHARED_REVIEW_TASK_IDS, "plan_coverage", "synthesis", "approval"],
    );
    assert.deepEqual(loaded.config.vars.implementation_run_id?.sources, ["cli", "web"]);
    assert.equal(loaded.config.vars.implementation_run_id?.required, true);
    assert.equal(loaded.config.vars.range?.default, "full");
    assert.deepEqual(loaded.config.vars.range?.sources, ["cli", "web"]);

    const orient = loaded.config.tasks.find((task) => task.id === "orient");
    const architecture = loaded.config.tasks.find((task) => task.id === "review/architecture");
    const planCoverage = loaded.config.tasks.find((task) => task.id === "plan_coverage");
    const approval = loaded.config.tasks.find((task) => task.id === "approval");

    assert.ok(orient);
    assert.ok(architecture);
    assert.ok(planCoverage);
    assert.ok(approval);
    assert.match(orient.body ?? "", /assignment-summary\.md/);
    assert.equal(architecture.title, "Architecture & module boundaries");
    assert.match(architecture.body ?? "", /Review the module layout/);
    assert.match(approval.body ?? "", /BLOCKED -- cannot approve/);
    assert.match(approval.body ?? "", /plan_coverage/);
    assert.match(approval.body ?? "", /silently during execution/);
  }));

test("built-in code-review-direct assignment resolves shared review tasks without implementation-run gates", () =>
  withEnv({ TASK_RUNNER_CONFIG_DIR: REPO_ROOT }, () => {
    const loaded = loadAssignmentConfig(BUILTIN_CODE_REVIEW_DIRECT_PATH);

    assert.deepEqual(
      loaded.config.tasks.map((task) => task.id),
      ["orient", ...SHARED_REVIEW_TASK_IDS, "synthesis", "approval"],
    );
    assert.deepEqual(Object.keys(loaded.config.vars), ["range"]);
    assert.equal(loaded.config.vars.range?.default, "full");
    assert.deepEqual(loaded.config.vars.range?.sources, ["cli", "web"]);
    assert.equal(
      loaded.config.tasks.some((task) => task.id === "plan_coverage"),
      false,
    );
    assert.equal(loaded.config.vars.implementation_run_id, undefined);

    const orient = loaded.config.tasks.find((task) => task.id === "orient");
    const synthesis = loaded.config.tasks.find((task) => task.id === "synthesis");
    const approval = loaded.config.tasks.find((task) => task.id === "approval");

    assert.ok(orient);
    assert.ok(synthesis);
    assert.ok(approval);
    assert.match(orient.body ?? "", /direct\/ad hoc/);
    assert.match(orient.body ?? "", /no `implementation_run_id`/);
    assert.match(synthesis.body ?? "", /top 10 highest-leverage findings/);
    assert.match(synthesis.body ?? "", /review\/architecture.*review\/docs-drift/s);
    assert.match(approval.body ?? "", /BLOCKED -- cannot approve/);
    assert.doesNotMatch(approval.body ?? "", /plan_coverage/);
  }));

test("built-in plan-feature assignment uses cwd instead of repo_path for canonical repo context", () => {
  const loaded = loadAssignmentConfig(BUILTIN_PLAN_FEATURE_PATH);
  assert.equal(loaded.config.vars.repo_path, undefined);
  assert.deepEqual(loaded.config.vars.worktree_slug?.sources, ["cli", "web"]);
  assert.deepEqual(loaded.config.vars.worktree_base_ref?.sources, ["cli", "web"]);
  assert.equal(loaded.config.vars.worktree_base_ref?.required, false);
  assert.equal(loaded.config.vars.worktree_base_ref?.default, "origin/main");
  assert.equal(loaded.config.hooks.prepare[0]?.path, "hooks/derive-worktree-vars.ts");
  assert.match(loaded.instructions, /`{{cwd}}`/);
  assert.ok((loaded.config.callerInstructions ?? "").includes("--assignment plan-feature"));
  assert.match(loaded.config.callerInstructions ?? "", /--var worktree_slug=<git-safe-slug>/);
  assert.match(
    loaded.config.callerInstructions ?? "",
    /--var worktree_base_ref=origin\/<feature-branch>/,
  );
  assert.match(loaded.config.callerInstructions ?? "", /`worktree_base_ref` is optional/);

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
  assert.match(
    template,
    /worktree_base_ref:\n\s+type: string\n\s+required: true\n\s+sources: \[parent\]/,
  );
  assert.match(template, /builtin: git-worktree/);
  assert.match(template, /attemptIndexInSession: \[0\]/);
  assert.match(template, /from: "\{\{worktree_base_ref\}\}"/);
  assert.match(template, /command: git\n\s+args:\n\s+- fetch\n\s+- origin\n\s+- --prune/);
  assert.match(
    template,
    /command: git\n\s+args:\n\s+- merge\n\s+- --ff-only\n\s+- --\n\s+- "\{\{worktree_base_ref\}\}"/,
  );
  assert.match(template, /collision: reuse/);
  assert.doesNotMatch(template, /from: main/);
  assert.doesNotMatch(template, /git merge --ff-only origin\/main/);
  assert.doesNotMatch(template, /command: bash/);
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
  assert.match(
    workflowTask.body ?? "",
    /repo_root`, `worktree_slug`, `worktree_path`, and\s+`worktree_base_ref` vars/,
  );
  assert.match(structureTask.body ?? "", /worktree_base_ref/);
  assert.doesNotMatch(structureTask.body ?? "", /origin\/main/);
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

test("direct assignment paths outside the config root may use authored names", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir }) => {
    const draftDir = join(rootDir, "drafts", "task-runner");
    mkdirSync(draftDir, { recursive: true });
    const assignmentPath = join(draftDir, "plan-feature-abcd.md");
    writeFileSync(
      assignmentPath,
      `---
schemaVersion: 1
name: implement-feature
maxRetries: 4
tasks:
  - id: t1
    title: Draft task
---
Draft assignment body.
`,
    );

    const loaded = loadAssignmentConfig(assignmentPath, rootDir);
    assert.equal(loaded.config.name, "implement-feature");
    assert.equal(loaded.config.tasks[0].id, "t1");
  }));

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

test("listAgentDefinitions and listAssignmentDefinitions warn-skip identity mismatches and bad task refs", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "reviewers/code",
      `---
schemaVersion: 1
name: wrong-agent-name
backend: claude
---
body
`,
    );
    writeTask(
      configDir,
      "review/reuse",
      `---
schemaVersion: 1
id: review/wrong
title: Reuse review
---
Task body.
`,
    );
    writeAssignment(
      configDir,
      "review/reuse",
      `---
schemaVersion: 1
name: review/reuse
tasks:
  - review/reuse
---
Assignment body.
`,
    );

    const agentResult = listAgentDefinitions();
    const assignmentResult = listAssignmentDefinitions();

    assert.deepEqual(agentResult.entries, []);
    assert.equal(agentResult.warnings.length, 1);
    assert.match(agentResult.warnings[0], /wrong-agent-name/);
    assert.match(agentResult.warnings[0], /reviewers\/code/);

    assert.deepEqual(assignmentResult.entries, []);
    assert.equal(assignmentResult.warnings.length, 1);
    assert.match(assignmentResult.warnings[0], /review\/reuse/);
    assert.match(assignmentResult.warnings[0], /Invalid task config/);

    assert.throws(
      () => loadAgentConfig("reviewers/code", rootDir),
      (error) => {
        assert.ok(error instanceof AgentConfigError);
        assert.match(error.message, /must match canonical id "reviewers\/code"/);
        return true;
      },
    );
    assert.throws(
      () => loadAssignmentConfig("review/reuse", rootDir),
      (error) => {
        assert.ok(error instanceof AssignmentConfigError);
        assert.match(error.message, /Invalid task config/);
        return true;
      },
    );
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
    assert.match(result.warnings.join("\n"), /must match canonical id/);
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
        assert.match(error.message, /must match canonical id/);
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

test("direct launcher paths outside the config root may use authored names", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir }) => {
    const launcherDir = join(rootDir, "external-launchers");
    mkdirSync(launcherDir, { recursive: true });
    const launcherPath = join(launcherDir, "ssh-wrapper.yaml");
    writeFileSync(
      launcherPath,
      `schemaVersion: 1
name: external-ssh
command: ssh
args: [worker]
`,
    );

    const loaded = loadLauncherConfig(launcherPath, rootDir);
    assert.equal(loaded.name, "external-ssh");
    assert.equal(loaded.config.name, "external-ssh");
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
