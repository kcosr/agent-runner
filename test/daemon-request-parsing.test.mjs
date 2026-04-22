import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RequestValidationError,
  optionalOverrides,
  parseResumeRunParams,
  parseStartRunParams,
} from "../apps/cli/dist/daemon/request-parsing.js";

test("optionalOverrides accepts launcher string refs", () => {
  assert.equal(optionalOverrides({ launcher: "shared" }).launcher, "shared");
});

test("optionalOverrides rejects malformed launcher overrides", () => {
  assert.throws(
    () => optionalOverrides({ launcher: "" }),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.match(error.message, /overrides\.launcher cannot be empty/);
      return true;
    },
  );
  assert.throws(
    () => optionalOverrides({ launcher: { command: "ssh" } }),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.match(error.message, /overrides\.launcher must be a string/);
      return true;
    },
  );
  assert.throws(
    () => optionalOverrides({ launcher: "./launchers/shared.yaml" }),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.match(error.message, /named launcher id/);
      return true;
    },
  );
});

test("parseStartRunParams accepts structured parentRunId", () => {
  const parsed = parseStartRunParams(
    {
      parentRunId: "parent-123",
      cliVars: {},
      overrides: {},
    },
    "runs.start params",
  );
  assert.equal(parsed.parentRunId, "parent-123");
});

test("parseStartRunParams rejects path-like parentRunId", () => {
  assert.throws(
    () =>
      parseStartRunParams(
        {
          parentRunId: "../parent",
          cliVars: {},
          overrides: {},
        },
        "runs.start params",
      ),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.match(error.message, /parentRunId must be a run id, not a path/);
      return true;
    },
  );
});

test("parseResumeRunParams accepts optional parentRunId", () => {
  const parsed = parseResumeRunParams(
    {
      target: "run-123",
      parentRunId: "parent-123",
      overrides: {},
    },
    "runs.resume params",
  );
  assert.equal(parsed.target, "run-123");
  assert.equal(parsed.parentRunId, "parent-123");
});
