import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveHttpBaseUrl,
  listenSocketConfig,
  resolveConnectUrl,
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
