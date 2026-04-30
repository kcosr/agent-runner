import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RequestValidationError,
  optionalOverrides,
  parseCliStartRunParams,
  parseResumeRunParams,
  parseRunReadyParams,
  parseRunScheduleParams,
  parseRunsReconfigureParams,
  parseStreamNotification,
  parseWebStartRunParams,
} from "../apps/cli/dist/daemon/request-parsing.js";

test("optionalOverrides accepts launcher string refs", () => {
  assert.equal(optionalOverrides({ launcher: "shared" }).launcher, "shared");
});

test("optionalOverrides accepts structured schedule overrides", () => {
  assert.deepEqual(
    optionalOverrides({ schedule: { cron: "0 9 * * *", timezone: "UTC" } }).schedule,
    {
      cron: "0 9 * * *",
      timezone: "UTC",
      at: undefined,
      delay: undefined,
      mode: undefined,
      continueOnFailure: undefined,
    },
  );
});

test("optionalOverrides accepts generic backendConfig overrides without backend-specific normalization", () => {
  assert.deepEqual(
    optionalOverrides({
      backendConfig: {
        codex: {
          transport: {
            type: "uds",
            path: " /tmp/codex.sock ",
          },
        },
        "my-agent": {
          nested: ["kept"],
        },
      },
    }).backendConfig,
    {
      codex: {
        transport: {
          type: "uds",
          path: " /tmp/codex.sock ",
        },
      },
      "my-agent": {
        nested: ["kept"],
      },
    },
  );
});

test("optionalOverrides rejects backendArgs override surface", () => {
  assert.throws(
    () =>
      optionalOverrides({
        backendArgs: {
          codex: {
            extraArgs: ["--flag"],
          },
        },
      }),
    /overrides\.backendArgs is not supported/,
  );
});

test("optionalOverrides rejects removed backend override fields", () => {
  assert.throws(
    () =>
      optionalOverrides({
        backendSpecific: {
          codex: {
            transport: { type: "stdio" },
          },
        },
      }),
    /overrides\.backendSpecific is not supported/,
  );
  assert.throws(
    () =>
      optionalOverrides({
        codexTransportEnv: {
          udsPath: "/tmp/codex.sock",
        },
      }),
    /overrides\.codexTransportEnv is not supported/,
  );
});

test("optionalOverrides rejects non-persistable backendConfig values", () => {
  assert.throws(
    () =>
      optionalOverrides({
        backendConfig: {
          codex: () => {},
        },
      }),
    /overrides\.backendConfig\.codex must be JSON-persistable data/,
  );
  assert.throws(
    () =>
      optionalOverrides({
        backendConfig: {
          codex: Number.NaN,
        },
      }),
    /overrides\.backendConfig\.codex must be JSON-persistable data/,
  );
  assert.throws(
    () =>
      optionalOverrides({
        backendConfig: {
          "": {},
        },
      }),
    /overrides\.backendConfig backend names must be non-empty strings/,
  );
});

test("optionalOverrides accepts shared backendConfig references without treating them as cycles", () => {
  const shared = { enabled: true };
  assert.deepEqual(
    optionalOverrides({
      backendConfig: {
        "custom-a": { shared },
        "custom-b": { shared },
      },
    }).backendConfig,
    {
      "custom-a": { shared },
      "custom-b": { shared },
    },
  );
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

test("parseCliStartRunParams accepts structured parentRunId", () => {
  const parsed = parseCliStartRunParams(
    {
      parentRunId: "parent-123",
      cliVars: {},
      overrides: {},
    },
    "runs.start params",
  );
  assert.equal(parsed.parentRunId, "parent-123");
});

test("parseCliStartRunParams rejects path-like parentRunId", () => {
  assert.throws(
    () =>
      parseCliStartRunParams(
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

test("parseWebStartRunParams accepts structured parentRunId", () => {
  const parsed = parseWebStartRunParams(
    {
      parentRunId: "parent-123",
      webVars: {},
      overrides: {},
    },
    "request body",
  );
  assert.equal(parsed.parentRunId, "parent-123");
});

test("parseCliStartRunParams requires cliVars", () => {
  assert.throws(
    () =>
      parseCliStartRunParams(
        {
          webVars: {},
          overrides: {},
        },
        "runs.start params",
      ),
    /cliVars must be an object/,
  );
});

test("parseWebStartRunParams requires webVars", () => {
  assert.throws(
    () =>
      parseWebStartRunParams(
        {
          cliVars: {},
          overrides: {},
        },
        "request body",
      ),
    /webVars must be an object/,
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

test("parseResumeRunParams rejects runGroupId", () => {
  assert.throws(
    () =>
      parseResumeRunParams(
        {
          target: "run-123",
          runGroupId: "group-123",
          overrides: {},
        },
        "runs.resume params",
      ),
    /runs\.resume params\.runGroupId is not supported/,
  );
});

test("parseRunReadyParams accepts schedule and rejects unknown keys", () => {
  const parsed = parseRunReadyParams(
    {
      target: "run-123",
      schedule: { delay: "10m" },
    },
    "runs.ready params",
  );
  assert.equal(parsed.target, "run-123");
  assert.equal(parsed.schedule.delay, "10m");

  assert.throws(
    () => parseRunReadyParams({ target: "run-123", extra: true }, "runs.ready params"),
    /runs\.ready params\.extra is not supported/,
  );
});

test("parseRunsReconfigureParams accepts vars and message only", () => {
  const parsed = parseRunsReconfigureParams(
    {
      target: "run-123",
      vars: { flavor: "mint" },
      message: "Re-render this run.",
    },
    "runs.reconfigure params",
  );
  assert.deepEqual(parsed, {
    target: "run-123",
    vars: { flavor: "mint" },
    message: "Re-render this run.",
  });

  assert.throws(
    () =>
      parseRunsReconfigureParams(
        { target: "run-123", vars: { flavor: "mint" }, backend: "codex" },
        "runs.reconfigure params",
      ),
    /runs\.reconfigure params\.backend is not supported/,
  );
  assert.throws(
    () =>
      parseRunsReconfigureParams(
        { target: "run-123", vars: {}, resolvedBackendArgs: ["--flag"] },
        "runs.reconfigure params",
      ),
    /runs\.reconfigure params\.resolvedBackendArgs is not supported/,
  );
  assert.throws(
    () =>
      parseRunsReconfigureParams(
        { target: "run-123", vars: { flavor: 7 } },
        "runs.reconfigure params",
      ),
    /runs\.reconfigure params\.vars\.flavor must be a string/,
  );
  assert.throws(
    () =>
      parseRunsReconfigureParams({ target: "run-123", message: null }, "runs.reconfigure params"),
    /runs\.reconfigure params\.message must be a string/,
  );
  assert.throws(
    () => parseRunsReconfigureParams({ target: "../run-123", vars: {} }, "runs.reconfigure params"),
    /runs\.reconfigure params\.target must be a run id, not a path/,
  );
});

test("parseRunScheduleParams requires schedule and rejects unknown schedule keys", () => {
  const parsed = parseRunScheduleParams(
    {
      target: "run-123",
      schedule: { at: "2026-04-25T12:00:00.000Z" },
    },
    "runs.setSchedule params",
  );
  assert.equal(parsed.schedule.at, "2026-04-25T12:00:00.000Z");

  assert.throws(
    () =>
      parseRunScheduleParams(
        { target: "run-123", schedule: { at: "2026-04-25T12:00:00.000Z", extra: true } },
        "runs.setSchedule params",
      ),
    /runs\.setSchedule params\.schedule\.extra is not supported/,
  );
});

test("parseStreamNotification validates stream window credit", () => {
  assert.deepEqual(
    parseStreamNotification({
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId: "stream-ok", bytes: 65_536 },
    }),
    {
      jsonrpc: "2.0",
      method: "stream.window",
      params: { streamId: "stream-ok", bytes: 65_536 },
    },
  );

  assert.throws(
    () =>
      parseStreamNotification({
        jsonrpc: "2.0",
        method: "stream.window",
        params: { streamId: "stream-zero", bytes: 0 },
      }),
    /stream\.window bytes must be a positive safe integer/,
  );

  assert.throws(
    () =>
      parseStreamNotification({
        jsonrpc: "2.0",
        method: "stream.window",
        params: { streamId: "stream-too-large", bytes: 1_048_577 },
      }),
    /stream\.window bytes must be less than or equal to 1048576/,
  );
});
