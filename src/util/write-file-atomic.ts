import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { shortId } from "./short-id.js";

export function writeTextFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${shortId()}.tmp`);
  let fd: number | null = null;

  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures during cleanup
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failures
    }
    throw err;
  }
}
