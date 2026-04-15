import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v7.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v7-"));
}

function writeManifest(root, repo, runId, manifest) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return join(dir, "run.json");
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("migrate-manifests-v7 script dry-runs v6 manifests and rejects broken v7 manifests", () => {
  const root = tempDir();
  const v6Path = writeManifest(root, "demo", "run-v6", {
    schemaVersion: 6,
    runId: "run-v6",
    pendingPrompt: "Current brief",
    taskMode: "file",
    resetSeed: {
      pendingPrompt: "Initial brief",
      taskMode: "file",
    },
    sessions: [],
    attemptRecords: [],
  });
  writeManifest(root, "demo", "run-v7-broken", {
    schemaVersion: 7,
    runId: "run-v7-broken",
    brief: null,
    resetSeed: {
      brief: "Seed brief",
    },
    sessions: [],
  });
  writeManifest(root, "demo", "run-v7", {
    schemaVersion: 7,
    runId: "run-v7",
    brief: "Current brief",
    resetSeed: {
      brief: "Seed brief",
    },
    sessions: [{ brief: "Session brief" }],
  });

  let error;
  let stdout = "";
  try {
    stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    error = err;
    stdout = err.stdout.toString();
    assert.equal(err.status, 1);
    assert.match(
      err.stderr.toString(),
      /run-v7-broken\/run\.json: schemaVersion 7 manifest is missing brief string/,
    );
  }
  assert.ok(error);
  assert.match(stdout, /DRY\s+.*run-v6\/run\.json/);
  assert.match(stdout, /OK\s+.*run-v7\/run\.json/);
  assert.equal(readManifest(v6Path).schemaVersion, 6);
});

test("migrate-manifests-v7 script writes v6 brief upgrades and strips obsolete prompt fields", () => {
  const root = tempDir();
  const v6Path = writeManifest(root, "demo", "run-v6", {
    schemaVersion: 6,
    runId: "run-v6",
    pendingPrompt: null,
    taskMode: "cli",
    resetSeed: {
      pendingPrompt: "Initial review brief",
      taskMode: "cli",
      dependencyRunIds: [],
    },
    sessions: [
      {
        sessionIndex: 0,
        firstAttempt: 1,
        lastAttempt: 1,
        message: null,
      },
      {
        sessionIndex: 1,
        firstAttempt: 2,
        lastAttempt: 2,
        message: "follow-up",
      },
    ],
    attemptRecords: [
      {
        attempt: 1,
        prompt: "Initial review brief",
      },
      {
        attempt: 2,
        prompt: "follow-up",
      },
    ],
  });
  const validV7Path = writeManifest(root, "demo", "run-v7", {
    schemaVersion: 7,
    runId: "run-v7",
    brief: "Current brief",
    resetSeed: {
      brief: "Seed brief",
    },
    sessions: [{ brief: "Session brief" }],
  });

  const writeRun = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(writeRun, /WRITE\s+.*run-v6\/run\.json/);
  assert.match(writeRun, /OK\s+.*run-v7\/run\.json/);
  assert.deepEqual(readManifest(v6Path), {
    schemaVersion: 7,
    runId: "run-v6",
    resetSeed: {
      dependencyRunIds: [],
      brief: "Initial review brief",
    },
    sessions: [
      {
        sessionIndex: 0,
        firstAttempt: 1,
        lastAttempt: 1,
        message: null,
        brief: "Initial review brief",
      },
      {
        sessionIndex: 1,
        firstAttempt: 2,
        lastAttempt: 2,
        message: "follow-up",
        brief: "follow-up",
      },
    ],
    attemptRecords: [
      {
        attempt: 1,
        prompt: "Initial review brief",
      },
      {
        attempt: 2,
        prompt: "follow-up",
      },
    ],
    brief: "follow-up",
  });
  assert.deepEqual(readManifest(validV7Path), {
    schemaVersion: 7,
    runId: "run-v7",
    brief: "Current brief",
    resetSeed: {
      brief: "Seed brief",
    },
    sessions: [{ brief: "Session brief" }],
  });
});
