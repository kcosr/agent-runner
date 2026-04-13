import { strict as assert } from "node:assert";
import path from "node:path";
import { test } from "node:test";
import { resolveFrontendPath } from "../apps/cli/dist/daemon/frontend.js";

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
