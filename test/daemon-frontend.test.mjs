import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { resolveFrontendPath, serveFrontendRequest } from "../apps/cli/dist/daemon/frontend.js";

test("resolveFrontendPath uses native filesystem semantics for Windows-style roots", () => {
  const root = String.raw`C:\Program Files\task-runner\apps\cli\dist\web`;
  assert.equal(
    resolveFrontendPath(root, "/", path.win32),
    String.raw`C:\Program Files\task-runner\apps\cli\dist\web\index.html`,
  );
  assert.equal(
    resolveFrontendPath(root, "/assets/app.js", path.win32),
    String.raw`C:\Program Files\task-runner\apps\cli\dist\web\assets\app.js`,
  );
});

test("resolveFrontendPath rejects traversal outside the frontend root", () => {
  const root = "/tmp/task-runner/apps/cli/dist/web";
  assert.equal(resolveFrontendPath(root, "/../secret"), null);
  assert.equal(resolveFrontendPath(root, "/../../etc/passwd"), null);
});

test("serveFrontendRequest converts filesystem errors into 500 responses", () => {
  const req = new EventEmitter();
  req.method = "GET";

  const res = {
    destroyed: false,
    headers: new Map(),
    statusCode: 200,
    writableEnded: false,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    end(chunk = "") {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.writableEnded = true;
    },
  };

  const failures = [];
  serveFrontendRequest(req, res, "/", {
    fsApi: {
      statSync() {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      readFileSync() {
        throw new Error("should not be called");
      },
    },
    logError(error) {
      failures.push(error);
    },
    rootPath: "/tmp/task-runner/apps/cli/dist/web",
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body, "Failed to read task-runner web assets.");
  assert.equal(failures.length, 1);
});
