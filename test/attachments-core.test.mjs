import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AttachmentPolicyError,
  MAX_ATTACHMENTS_PER_RUN,
  MAX_ATTACHMENT_BYTES,
  createAttachmentRelativePath,
  resolveAttachmentMimeType,
  resolveAttachmentOutputPath,
  sanitizeAttachmentFilename,
  stageAttachmentFromFile,
} from "../packages/core/dist/core/run/attachments.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-attachments-core-"));
}

function manifest(workspaceDir, attachments = []) {
  return {
    runId: "run-attachments",
    workspaceDir,
    attachments,
  };
}

test("attachment helpers resolve MIME types and sanitize storage paths", () => {
  assert.equal(resolveAttachmentMimeType("notes.md"), "text/markdown; charset=utf-8");
  assert.equal(resolveAttachmentMimeType("archive.bin"), "application/octet-stream");
  assert.equal(resolveAttachmentMimeType("notes.md", "text/plain"), "text/plain");
  assert.equal(sanitizeAttachmentFilename(" ../notes.md "), "notes.md");
  assert.equal(createAttachmentRelativePath("att-123", "notes.md"), "attachments/att-123/notes.md");
});

test("stageAttachmentFromFile enforces attachment count and file size limits", async () => {
  const dir = tempDir();
  const smallPath = join(dir, "small.txt");
  const largePath = join(dir, "large.bin");
  writeFileSync(smallPath, "ok\n");
  writeFileSync(largePath, "");
  truncateSync(largePath, MAX_ATTACHMENT_BYTES + 1);

  await assert.rejects(
    stageAttachmentFromFile(
      manifest(
        dir,
        Array.from({ length: MAX_ATTACHMENTS_PER_RUN }, (_, index) => ({
          id: `att-${index}`,
          size: 0,
        })),
      ),
      {
        id: "att-overflow",
        name: "small.txt",
        sourcePath: smallPath,
      },
    ),
    (error) => {
      assert(error instanceof AttachmentPolicyError);
      assert.match(error.message, /already has 20 attachments/);
      return true;
    },
  );

  await assert.rejects(
    stageAttachmentFromFile(manifest(dir), {
      id: "att-large",
      name: "large.bin",
      sourcePath: largePath,
    }),
    (error) => {
      assert(error instanceof AttachmentPolicyError);
      assert.match(error.message, /25 MiB max/);
      return true;
    },
  );
});

test("resolveAttachmentOutputPath respects directories and existing destinations", () => {
  const dir = tempDir();
  const downloadsDir = join(dir, "downloads");
  const existingPath = join(dir, "existing.txt");
  mkdirSync(downloadsDir);
  writeFileSync(existingPath, "already here\n");

  assert.equal(
    resolveAttachmentOutputPath(downloadsDir, "notes.md"),
    join(downloadsDir, "notes.md"),
  );
  assert.equal(
    resolveAttachmentOutputPath(`${downloadsDir}/`, "notes.md"),
    join(downloadsDir, "notes.md"),
  );
  assert.throws(
    () => resolveAttachmentOutputPath(existingPath, "notes.md"),
    /destination file .*existing\.txt already exists/,
  );
});
