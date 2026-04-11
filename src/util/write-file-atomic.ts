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
  let dirFd: number | null = null;

  try {
    fd = openSync(tmpPath, "w", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
    dirFd = null;
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures during cleanup
      }
    }
    if (dirFd !== null) {
      try {
        closeSync(dirFd);
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
