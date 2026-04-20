import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveHttpBaseUrl,
  listenSocketConfig,
  resolveConnectUrl,
  resolveHostMode,
  resolveListenUrl,
} from "../apps/cli/dist/daemon/config.js";

test("daemon config accepts non-loopback listen URLs", () => {
  const listenUrl = resolveListenUrl("ws://0.0.0.0:5001/ws");
  assert.equal(listenUrl, "ws://0.0.0.0:5001/ws");
  assert.deepEqual(listenSocketConfig(listenUrl), {
    host: "0.0.0.0",
    port: 5001,
    path: "/ws",
  });
  assert.equal(deriveHttpBaseUrl(listenUrl), "http://0.0.0.0:5001/");
});

test("daemon config accepts non-loopback connect URLs", () => {
  const connectUrl = resolveConnectUrl("ws://example.com:6123/control");
  assert.equal(connectUrl, "ws://example.com:6123/control");
});

test("daemon config keeps logical and effective connect URLs aligned when connect-host is absent", () => {
  const result = resolveHostMode("ws://example.com:6123/control");
  assert.deepEqual(result, {
    mode: "daemon",
    connectUrl: "ws://example.com:6123/control",
    effectiveConnectUrl: "ws://example.com:6123/control",
  });
});

test("daemon config resolves connect-host from env and reuses the logical port by default", () => {
  const result = resolveHostMode(undefined, undefined, undefined, {
    TASK_RUNNER_CONNECT: "ws://remote-daemon.internal:4773/control?view=full#frag",
    TASK_RUNNER_CONNECT_HOST: "prod-box",
  });
  assert.equal(result.mode, "daemon");
  assert.equal(result.connectUrl, "ws://remote-daemon.internal:4773/control?view=full#frag");
  assert.equal(result.effectiveConnectUrl, "ws://127.0.0.1:4773/control?view=full#frag");
  assert.deepEqual(result.connectHost, {
    host: "prod-box",
    localPort: 4773,
    targetHost: "remote-daemon.internal",
    targetPort: 4773,
  });
});

test("daemon config lets CLI flags override connect-host env settings", () => {
  const result = resolveHostMode(
    "ws://remote-daemon.internal:4773/control",
    "staging-box",
    "5773",
    {
      TASK_RUNNER_CONNECT_HOST: "prod-box",
      TASK_RUNNER_CONNECT_LOCAL_PORT: "6773",
    },
  );
  assert.equal(result.mode, "daemon");
  assert.equal(result.effectiveConnectUrl, "ws://127.0.0.1:5773/control");
  assert.deepEqual(result.connectHost, {
    host: "staging-box",
    localPort: 5773,
    targetHost: "remote-daemon.internal",
    targetPort: 4773,
  });
});

test("daemon config rejects connect-host and local-port misconfigurations", () => {
  assert.throws(
    () => resolveHostMode(undefined, "prod-box", undefined, {}),
    /--connect-host requires --connect or TASK_RUNNER_CONNECT/,
  );
  assert.throws(
    () => resolveHostMode("ws://example.com:4773/", undefined, "5773", {}),
    /--connect-local-port requires --connect-host or TASK_RUNNER_CONNECT_HOST/,
  );
  assert.throws(
    () => resolveHostMode("ws://example.com:4773/", "prod-box", "abc", {}),
    /--connect-local-port must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => resolveHostMode("ws://example.com:4773/", "prod-box", "70000", {}),
    /--connect-local-port must be an integer between 1 and 65535/,
  );
});
