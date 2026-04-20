import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RequestValidationError,
  optionalOverrides,
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
