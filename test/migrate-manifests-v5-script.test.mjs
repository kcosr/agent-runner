import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v5.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v5-"));
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

test("migrate-manifests-v5 script dry-runs and writes v4/v5 dependency field fixes", () => {
  const root = tempDir();
  const v4Path = writeManifest(root, "demo", "run-v4", {
    schemaVersion: 4,
    runId: "run-v4",
    resetSeed: {},
  });
  const brokenV5Path = writeManifest(root, "demo", "run-v5", {
    schemaVersion: 5,
    runId: "run-v5",
    dependencyRunIds: null,
    resetSeed: {
      dependencyRunIds: null,
    },
  });
  const validV5Path = writeManifest(root, "demo", "run-ok", {
    schemaVersion: 5,
    runId: "run-ok",
    dependencyRunIds: [],
    resetSeed: {
      dependencyRunIds: [],
    },
  });

  const dryRun = execFileSync("node", [SCRIPT_PATH, "--root", root], {
    encoding: "utf8",
  });

  assert.match(dryRun, /DRY\s+.*run-v4\/run\.json/);
  assert.match(dryRun, /DRY\s+.*run-v5\/run\.json/);
  assert.match(dryRun, /OK\s+.*run-ok\/run\.json/);
  assert.equal(readManifest(v4Path).schemaVersion, 4);
  assert.equal(readManifest(brokenV5Path).dependencyRunIds, null);

  const writeRun = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(writeRun, /WRITE\s+.*run-v4\/run\.json/);
  assert.match(writeRun, /WRITE\s+.*run-v5\/run\.json/);
  assert.match(writeRun, /OK\s+.*run-ok\/run\.json/);

  assert.deepEqual(readManifest(v4Path), {
    schemaVersion: 5,
    runId: "run-v4",
    dependencyRunIds: [],
    resetSeed: {
      dependencyRunIds: [],
    },
  });
  assert.deepEqual(readManifest(brokenV5Path), {
    schemaVersion: 5,
    runId: "run-v5",
    dependencyRunIds: [],
    resetSeed: {
      dependencyRunIds: [],
    },
  });
  assert.deepEqual(readManifest(validV5Path), {
    schemaVersion: 5,
    runId: "run-ok",
    dependencyRunIds: [],
    resetSeed: {
      dependencyRunIds: [],
    },
  });
});
