import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { deriveRepoSlug } from "../packages/core/dist/core/hooks/builtin-git-clone.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { setTaskStatusesForPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const AGENT = `---
schemaVersion: 1
name: reviewer
backend: claude
---
Review.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-git-clone-"));
}

function gitEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return !key.startsWith("GIT_");
    }),
  );
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

function writeAgent(baseDir) {
  const agentDir = join(baseDir, "agents", "reviewer");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.md"), AGENT);
}

function writeAssignment(baseDir, body) {
  const assignmentDir = join(baseDir, "assignments", "clone-review");
  mkdirSync(assignmentDir, { recursive: true });
  writeFileSync(join(assignmentDir, "assignment.md"), body);
}

function cloneAssignment(extraWith = "") {
  return `---
schemaVersion: 1
name: clone-review
vars:
  repo_url:
    type: string
    required: true
    sources: [cli, web]
  ref:
    type: string
    required: false
    sources: [cli, web]
hooks:
  prepare:
    - builtin: git-clone
      with:
        repo_url: "{{repo_url}}"
        ref: "{{ref}}"
${extraWith}
tasks:
  - id: t1
    title: Review
---
Review cloned repo at {{cwd}}.
`;
}

function initSourceRepo(baseDir) {
  const repoDir = join(baseDir, "repo");
  const hooksDir = join(repoDir, ".githooks-disabled");
  mkdirSync(repoDir, { recursive: true });
  git(["init", "--initial-branch=main", repoDir], baseDir);
  mkdirSync(hooksDir, { recursive: true });
  git(["config", "core.hooksPath", hooksDir], repoDir);
  git(["config", "user.name", "Task Runner Tests"], repoDir);
  git(["config", "user.email", "tests@example.com"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "main\n");
  git(["add", "README.md"], repoDir);
  git(["commit", "-m", "main"], repoDir);
  const mainSha = git(["rev-parse", "HEAD"], repoDir);

  git(["checkout", "-b", "feature"], repoDir);
  writeFileSync(join(repoDir, "README.md"), "feature\n");
  git(["commit", "-am", "feature"], repoDir);
  const featureSha = git(["rev-parse", "HEAD"], repoDir);
  git(["tag", "feature-tag"], repoDir);
  git(["checkout", "main"], repoDir);

  return { repoDir, mainSha, featureSha };
}

async function runClone(baseDir, options = {}) {
  let backendInvoked = false;
  const seen = {};
  return await withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("reviewer", baseDir);
    const loadedAssignment = loadAssignmentConfig("clone-review", baseDir);
    const outcome = await runAgent({
      loaded,
      loadedAssignment,
      cliVars: options.cliVars,
      webVars: {},
      backend: {
        id: "claude",
        async invoke(ctx) {
          backendInvoked = true;
          seen.cwd = ctx.cwd;
          setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, baseDir);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "clone-session",
            transcript: "done",
            rawStdout: "",
            rawStderr: "",
          };
        },
      },
      callerCwd: baseDir,
    });
    return { outcome, backendInvoked, seen };
  });
}

test("git-clone slug derivation handles supported URL shapes and rejects unusable slugs", () => {
  assert.equal(deriveRepoSlug("git@github.com:kcosr/task-runner.git"), "task-runner");
  assert.equal(deriveRepoSlug("https://github.com/kcosr/task-runner.git"), "task-runner");
  assert.equal(deriveRepoSlug("ssh://git@host/org/my-repo.git"), "my-repo");
  assert.equal(deriveRepoSlug("https://github.com/org/my repo!.git"), "my-repo");
  assert.equal(deriveRepoSlug("file:///tmp/unsafe repo!.git"), "unsafe-repo");
  assert.throws(() => deriveRepoSlug("https://github.com/org/.git"), /git-clone invalid slug/);
});

test("git-clone prepare hook clones default ref, mutates cwd, and projects runtime vars", async () => {
  const dir = tempDir();
  try {
    writeAgent(dir);
    writeAssignment(dir, cloneAssignment());
    const { repoDir, mainSha } = initSourceRepo(dir);

    const { outcome, backendInvoked, seen } = await runClone(dir, {
      cliVars: { repo_url: repoDir },
    });

    const expectedPath = join(dir, "checkouts", `repo-${outcome.runId}`);
    assert.equal(backendInvoked, true);
    assert.equal(seen.cwd, expectedPath);
    assert.equal(outcome.manifest.cwd, expectedPath);
    assert.equal(outcome.manifest.runtimeVars.repo_slug, "repo");
    assert.equal(outcome.manifest.runtimeVars.checkout_path, expectedPath);
    assert.equal(outcome.manifest.runtimeVars.commit_sha, mainSha);
    assert.equal(outcome.manifest.runtimeVars.resolved_ref, "main");
    assert.equal(readFileSync(join(expectedPath, "README.md"), "utf8"), "main\n");
    assert.equal(git(["rev-parse", "HEAD"], expectedPath), mainSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-clone prepare hook checks out supplied refs and records the selected commit", async () => {
  const dir = tempDir();
  try {
    writeAgent(dir);
    writeAssignment(dir, cloneAssignment("        remote_name: upstream\n"));
    const { repoDir, featureSha } = initSourceRepo(dir);

    const { outcome } = await runClone(dir, {
      cliVars: { repo_url: repoDir, ref: "feature" },
    });

    const checkoutPath = outcome.manifest.runtimeVars.checkout_path;
    assert.equal(outcome.manifest.runtimeVars.commit_sha, featureSha);
    assert.equal(outcome.manifest.runtimeVars.resolved_ref, "feature");
    assert.equal(git(["rev-parse", "HEAD"], checkoutPath), featureSha);
    assert.equal(git(["remote"], checkoutPath), "upstream");
    assert.equal(readFileSync(join(checkoutPath, "README.md"), "utf8"), "feature\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-clone prepare failures block before backend invocation", async () => {
  const dir = tempDir();
  try {
    writeAgent(dir);
    const { repoDir } = initSourceRepo(dir);
    const collisionDir = join(dir, "collision");
    mkdirSync(collisionDir, { recursive: true });
    writeFileSync(join(collisionDir, "file.txt"), "occupied\n");
    writeAssignment(dir, cloneAssignment(`        path: ${JSON.stringify(collisionDir)}\n`));

    let backendInvoked = false;
    await assert.rejects(
      () =>
        withSharedRuntimeEnv(dir, async () => {
          const loaded = loadAgentConfig("reviewer", dir);
          const loadedAssignment = loadAssignmentConfig("clone-review", dir);
          await runAgent({
            loaded,
            loadedAssignment,
            cliVars: { repo_url: repoDir },
            webVars: {},
            backend: {
              id: "claude",
              async invoke() {
                backendInvoked = true;
                throw new Error("backend should not run");
              },
            },
            callerCwd: dir,
          });
        }),
      /git-clone path collision/,
    );
    assert.equal(backendInvoked, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-clone prepare hook rejects camelCase config aliases", async () => {
  for (const alias of ["repoUrl", "remoteName"]) {
    const dir = tempDir();
    try {
      writeAgent(dir);
      const { repoDir } = initSourceRepo(dir);
      writeAssignment(
        dir,
        cloneAssignment(
          `        ${alias}: ${JSON.stringify(alias === "repoUrl" ? repoDir : "upstream")}\n`,
        ),
      );
      let backendInvoked = false;
      await assert.rejects(
        () =>
          withSharedRuntimeEnv(dir, async () => {
            const loaded = loadAgentConfig("reviewer", dir);
            const loadedAssignment = loadAssignmentConfig("clone-review", dir);
            await runAgent({
              loaded,
              loadedAssignment,
              cliVars: { repo_url: repoDir },
              webVars: {},
              backend: {
                id: "claude",
                async invoke() {
                  backendInvoked = true;
                  throw new Error("backend should not run");
                },
              },
              callerCwd: dir,
            });
          }),
        new RegExp(`unknown field\\(s\\): ${alias}`),
      );
      assert.equal(backendInvoked, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("git-clone prepare fails clearly for invalid slugs and missing refs", async () => {
  const invalidDir = tempDir();
  try {
    writeAgent(invalidDir);
    writeAssignment(invalidDir, cloneAssignment());
    let backendInvoked = false;
    await assert.rejects(
      () =>
        withSharedRuntimeEnv(invalidDir, async () => {
          const loaded = loadAgentConfig("reviewer", invalidDir);
          const loadedAssignment = loadAssignmentConfig("clone-review", invalidDir);
          await runAgent({
            loaded,
            loadedAssignment,
            cliVars: { repo_url: "https://github.com/org/.git" },
            webVars: {},
            backend: {
              id: "claude",
              async invoke() {
                backendInvoked = true;
                throw new Error("backend should not run");
              },
            },
            callerCwd: invalidDir,
          });
        }),
      /git-clone invalid slug/,
    );
    assert.equal(backendInvoked, false);
  } finally {
    rmSync(invalidDir, { recursive: true, force: true });
  }

  const missingRefDir = tempDir();
  try {
    writeAgent(missingRefDir);
    writeAssignment(missingRefDir, cloneAssignment());
    const { repoDir } = initSourceRepo(missingRefDir);
    let backendInvoked = false;
    await assert.rejects(
      () =>
        withSharedRuntimeEnv(missingRefDir, async () => {
          const loaded = loadAgentConfig("reviewer", missingRefDir);
          const loadedAssignment = loadAssignmentConfig("clone-review", missingRefDir);
          await runAgent({
            loaded,
            loadedAssignment,
            cliVars: { repo_url: repoDir, ref: "missing-ref" },
            webVars: {},
            backend: {
              id: "claude",
              async invoke() {
                backendInvoked = true;
                throw new Error("backend should not run");
              },
            },
            callerCwd: missingRefDir,
          });
        }),
      /git-clone checkout failed/,
    );
    assert.equal(backendInvoked, false);
    assert.equal(existsSync(join(missingRefDir, "checkouts")), true);
  } finally {
    rmSync(missingRefDir, { recursive: true, force: true });
  }
});
