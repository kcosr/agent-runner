import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-attempt-stdout-field.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-attempt-stdout-"));
}

function writeJson(path, value) {
  mkdirSync(resolvePath(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function attemptLog(overrides = {}) {
  return {
    schemaVersion: 2,
    runId: "run-a",
    attemptNumber: 1,
    sessionIndex: 0,
    attemptIndexInSession: 0,
    startedAt: "2026-04-30T00:00:00.000Z",
    endedAt: "2026-04-30T00:00:01.000Z",
    stdout: "legacy stdout",
    stderr: "stderr notice",
    customField: "preserved",
    ...overrides,
  };
}

test("migrate-attempt-stdout-field dry-runs and writes selected repos", () => {
  const root = tempDir();
  const selected = join(root, "runs", "demo", "run-a", "attempts", "01.json");
  const canonical = join(root, "runs", "demo", "run-a", "attempts", "02.json");
  const skipped = join(root, "runs", "other", "run-b", "attempts", "01.json");
  writeJson(selected, attemptLog());
  writeJson(canonical, attemptLog({ attemptNumber: 2, schemaVersion: 3, stdout: undefined }));
  writeJson(skipped, attemptLog({ runId: "run-b" }));

  const dry = execFileSync(process.execPath, [SCRIPT_PATH, "--root", root, "--repo", "demo"], {
    encoding: "utf8",
  });

  assert.match(
    dry,
    /DRY\s+runs\/demo\/run-a\/attempts\/01\.json: would migrate to schemaVersion 3/,
  );
  assert.match(dry, /OK\s+runs\/demo\/run-a\/attempts\/02\.json: already has no stdout field/);
  assert.doesNotMatch(dry, /runs\/other/);
  assert.equal(readJson(selected).stdout, "legacy stdout");

  const written = execFileSync(
    process.execPath,
    [SCRIPT_PATH, "--root", root, "--repo", "demo", "--write"],
    { encoding: "utf8" },
  );

  assert.match(
    written,
    /WRITE\s+runs\/demo\/run-a\/attempts\/01\.json: migrated to schemaVersion 3/,
  );
  const migrated = readJson(selected);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal("stdout" in migrated, false);
  assert.equal(migrated.stderr, "stderr notice");
  assert.equal(migrated.customField, "preserved");
  assert.equal(readJson(skipped).stdout, "legacy stdout");
});

test("migrate-attempt-stdout-field supports explicit files and reports invalid logs", () => {
  const root = tempDir();
  const selected = join(root, "runs", "demo", "run-a", "attempts", "01.json");
  const invalid = join(root, "runs", "demo", "run-a", "attempts", "bad.json");
  writeJson(selected, attemptLog());
  writeJson(invalid, { schemaVersion: 1, stdout: "wrong schema" });

  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--file", selected, "--file", invalid], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /DRY\s+.*01\.json: would migrate to schemaVersion 3/);
  assert.match(result.stdout, /ERROR\s+.*bad\.json: attempt log must have schemaVersion 2 or 3/);
  assert.match(result.stdout, /SUMMARY migrated=1 conversionErrors=1/);
});
