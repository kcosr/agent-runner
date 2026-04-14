import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v6.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v6-"));
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

test("migrate-manifests-v6 script dry-runs and rejects broken v6 manifests", () => {
  const root = tempDir();
  const v5Path = writeManifest(root, "demo", "run-v5", {
    schemaVersion: 5,
    runId: "run-v5",
  });
  writeManifest(root, "demo", "run-v6-broken", {
    schemaVersion: 6,
    runId: "run-v6-broken",
    attachments: null,
  });
  writeManifest(root, "demo", "run-v6", {
    schemaVersion: 6,
    runId: "run-v6",
    attachments: [],
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
      /run-v6-broken\/run\.json: schemaVersion 6 manifest is missing attachments array/,
    );
  }
  assert.ok(error);
  assert.match(stdout, /DRY\s+.*run-v5\/run\.json/);
  assert.match(stdout, /OK\s+.*run-v6\/run\.json/);
  assert.equal(readManifest(v5Path).schemaVersion, 5);
});

test("migrate-manifests-v6 script writes v5 attachment upgrades", () => {
  const root = tempDir();
  const v5Path = writeManifest(root, "demo", "run-v5", {
    schemaVersion: 5,
    runId: "run-v5",
  });
  const validV6Path = writeManifest(root, "demo", "run-v6", {
    schemaVersion: 6,
    runId: "run-v6",
    attachments: [],
  });

  const writeRun = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(writeRun, /WRITE\s+.*run-v5\/run\.json/);
  assert.match(writeRun, /OK\s+.*run-v6\/run\.json/);
  assert.deepEqual(readManifest(v5Path), {
    schemaVersion: 6,
    runId: "run-v5",
    attachments: [],
  });
  assert.deepEqual(readManifest(validV6Path), {
    schemaVersion: 6,
    runId: "run-v6",
    attachments: [],
  });
});
