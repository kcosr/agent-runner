import { spawn } from "node:child_process";
import { constants, promises as fs, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_WORKSPACE_DIFF_BYTES,
  MAX_WORKSPACE_DIFF_UNTRACKED_FILE_BYTES,
  WORKSPACE_DIFF_TIMEOUT_MS,
  type WorkspaceDiff,
  type WorkspaceDiffFile,
  type WorkspaceDiffFileStatus,
  type WorkspaceDiffInput,
} from "../../contracts/workspace-diffs.js";
import type { RunManifest } from "./manifest.js";

export class WorkspaceDiffError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceDiffError";
  }
}

export class WorkspaceDiffInvalidRequestError extends WorkspaceDiffError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDiffInvalidRequestError";
  }
}

interface GitResult {
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
}

interface FileStat {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

interface StatusEntry {
  path: string;
  oldPath?: string;
  status: WorkspaceDiffFileStatus;
}

interface PatchAccumulator {
  chunks: string[];
  bytes: number;
  truncated: boolean;
}

const DIFF_ARGS = ["--no-ext-diff", "--no-color", "--find-renames", "--find-copies"];
const UNTRACKED_FILE_CONCURRENCY = 8;

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function codeFromError(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : null;
}

function binaryWorkspaceDiffFile(path: string): WorkspaceDiffFile {
  return { path, status: "binary", additions: null, deletions: null, binary: true };
}

function missingUntrackedWorkspaceDiffFile(path: string): WorkspaceDiffFile {
  return { path, status: "untracked", additions: 0, deletions: 0, binary: false };
}

function realCwd(manifest: Pick<RunManifest, "cwd" | "runId">): string {
  try {
    return realpathSync(manifest.cwd);
  } catch (err) {
    throw new WorkspaceDiffError(`workspace cwd for run ${manifest.runId} is not readable`, {
      cause: err,
    });
  }
}

function isContainedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length === 0 || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function runGit(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; allowTruncate?: boolean } = {},
): Promise<GitResult> {
  const maxBytes = options.maxBytes ?? MAX_WORKSPACE_DIFF_BYTES;
  const allowTruncate = options.allowTruncate ?? false;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, {
      cwd,
      env: sanitizedGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, WORKSPACE_DIFF_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) {
        return;
      }
      const remaining = maxBytes - stdoutBytes;
      if (chunk.length > remaining) {
        truncated = true;
        stdoutChunks.push(chunk.subarray(0, Math.max(remaining, 0)));
        stdoutBytes = maxBytes;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(new WorkspaceDiffError("failed to start git", { cause: err }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        rejectPromise(new WorkspaceDiffError(`git timed out after ${WORKSPACE_DIFF_TIMEOUT_MS}ms`));
        return;
      }
      if (truncated && allowTruncate) {
        resolvePromise({ stdout: Buffer.concat(stdoutChunks), stderr, truncated: true });
        return;
      }
      if (code !== 0) {
        rejectPromise(
          new WorkspaceDiffError(
            `git ${args[0] ?? "command"} failed${stderr.length > 0 ? `: ${stderr}` : ""}`,
          ),
        );
        return;
      }
      if (signal !== null) {
        rejectPromise(new WorkspaceDiffError(`git ${args[0] ?? "command"} exited by ${signal}`));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(stdoutChunks), stderr, truncated });
    });
  });
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args, { maxBytes: MAX_WORKSPACE_DIFF_BYTES });
  return result.stdout.toString("utf8").trim();
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    return await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    throw new WorkspaceDiffError(`workspace cwd "${cwd}" is not inside a Git work tree`, {
      cause: err,
    });
  }
}

async function assertCommitRef(cwd: string, ref: string, label: string): Promise<void> {
  try {
    await gitText(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (err) {
    throw new WorkspaceDiffError(`missing git ${label} ref "${ref}"`, { cause: err });
  }
}

function tokensFromZ(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((token) => token.length > 0);
}

function statusFromToken(token: string): WorkspaceDiffFileStatus {
  const code = token[0];
  if (code === "A") {
    return "added";
  }
  if (code === "D") {
    return "deleted";
  }
  if (code === "R") {
    return "renamed";
  }
  if (code === "C") {
    return "copied";
  }
  if (code === "M" || code === "T") {
    return "modified";
  }
  throw new WorkspaceDiffError(`unsupported git diff status "${token}"`);
}

function parseNameStatus(output: Buffer): StatusEntry[] {
  const tokens = tokensFromZ(output);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index];
    if (statusToken === undefined) {
      break;
    }
    index += 1;
    const status = statusFromToken(statusToken);
    if (status === "renamed" || status === "copied") {
      const oldPath = tokens[index];
      const path = tokens[index + 1];
      if (oldPath === undefined || path === undefined) {
        break;
      }
      index += 2;
      entries.push({ path, oldPath, status });
    } else {
      const path = tokens[index];
      if (path === undefined) {
        break;
      }
      index += 1;
      entries.push({ path, status });
    }
  }
  return entries;
}

function parseNumstat(output: Buffer): FileStat[] {
  const tokens = tokensFromZ(output);
  const stats: FileStat[] = [];
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    index += 1;
    const fields = token.split("\t");
    if (fields.length < 3) {
      continue;
    }
    const [additionsRaw, deletionsRaw, pathRaw] = fields;
    if (additionsRaw === undefined || deletionsRaw === undefined || pathRaw === undefined) {
      continue;
    }
    let path = pathRaw;
    if (path.length === 0 && index + 1 < tokens.length) {
      index += 1;
      const renamePath = tokens[index];
      if (renamePath === undefined) {
        break;
      }
      index += 1;
      path = renamePath;
    }
    const binary = additionsRaw === "-" || deletionsRaw === "-";
    stats.push({
      path,
      additions: binary ? null : Number(additionsRaw),
      deletions: binary ? null : Number(deletionsRaw),
      binary,
    });
  }
  return stats;
}

function addOrMergeFile(files: Map<string, WorkspaceDiffFile>, file: WorkspaceDiffFile): void {
  const existing = files.get(file.path);
  if (existing === undefined) {
    files.set(file.path, file);
    return;
  }
  existing.additions =
    existing.additions === null || file.additions === null
      ? null
      : existing.additions + file.additions;
  existing.deletions =
    existing.deletions === null || file.deletions === null
      ? null
      : existing.deletions + file.deletions;
  existing.binary = existing.binary || file.binary;
  if (file.oldPath !== undefined) {
    existing.oldPath = file.oldPath;
  }
  if (existing.binary) {
    existing.status = "binary";
  } else if (existing.status === "modified" && file.status !== "modified") {
    existing.status = file.status;
  }
}

function filesFromGitOutput(statuses: StatusEntry[], stats: FileStat[]): WorkspaceDiffFile[] {
  const statsByPath = new Map(stats.map((stat) => [stat.path, stat]));
  return statuses.map((entry) => {
    const stat = statsByPath.get(entry.path);
    const binary = stat?.binary ?? false;
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: binary ? "binary" : entry.status,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary,
    };
  });
}

async function diffFiles(cwd: string, args: string[]): Promise<WorkspaceDiffFile[]> {
  const [statusResult, statResult] = await Promise.all([
    runGit(cwd, ["diff", ...args, "--name-status", "-z", "--"], {
      maxBytes: MAX_WORKSPACE_DIFF_BYTES,
    }),
    runGit(cwd, ["diff", ...args, "--numstat", "-z", "--"], {
      maxBytes: MAX_WORKSPACE_DIFF_BYTES,
    }),
  ]);
  return filesFromGitOutput(parseNameStatus(statusResult.stdout), parseNumstat(statResult.stdout));
}

async function diffPatch(cwd: string, args: string[]): Promise<GitResult> {
  return await runGit(cwd, ["diff", ...args, "--"], {
    maxBytes: MAX_WORKSPACE_DIFF_BYTES,
    allowTruncate: true,
  });
}

function appendPatch(accumulator: PatchAccumulator, patch: string): void {
  if (patch.length === 0 || accumulator.truncated) {
    return;
  }
  const buffer = Buffer.from(patch);
  const remaining = MAX_WORKSPACE_DIFF_BYTES - accumulator.bytes;
  if (buffer.length > remaining) {
    accumulator.chunks.push(buffer.subarray(0, Math.max(remaining, 0)).toString("utf8"));
    accumulator.bytes = MAX_WORKSPACE_DIFF_BYTES;
    accumulator.truncated = true;
    return;
  }
  accumulator.chunks.push(patch);
  accumulator.bytes += buffer.length;
}

async function listUntrackedFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], {
    maxBytes: MAX_WORKSPACE_DIFF_BYTES,
  });
  return tokensFromZ(result.stdout);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function decodeUtf8(buffer: Buffer): string | null {
  if (hasNulByte(buffer)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function untrackedPatch(path: string, text: string): string {
  const lines = text.length === 0 ? [] : text.split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  const lineCount = lines.length;
  const suffix = body.length > 0 ? `\n${body}\n` : "\n";
  return (
    [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lineCount} @@`,
    ].join("\n") + suffix
  );
}

async function readUntrackedFile(
  repoRoot: string,
  path: string,
): Promise<{ file: WorkspaceDiffFile; patch: string }> {
  const absolutePath = resolve(repoRoot, path);
  if (!isContainedBy(repoRoot, absolutePath)) {
    throw new WorkspaceDiffInvalidRequestError(`untracked path "${path}" escapes repo root`);
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(absolutePath);
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      return {
        file: missingUntrackedWorkspaceDiffFile(path),
        patch: "",
      };
    }
    throw new WorkspaceDiffError(`untracked file "${path}" is not readable`, { cause: err });
  }
  if (!isContainedBy(repoRoot, realPath)) {
    throw new WorkspaceDiffInvalidRequestError(`untracked path "${path}" resolves outside repo`);
  }

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedRealPath = await fs.realpath(absolutePath);
    if (openedRealPath !== realPath || !isContainedBy(repoRoot, openedRealPath)) {
      return { file: binaryWorkspaceDiffFile(path), patch: "" };
    }
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_WORKSPACE_DIFF_UNTRACKED_FILE_BYTES) {
      return { file: binaryWorkspaceDiffFile(path), patch: "" };
    }
    const buffer = Buffer.alloc(MAX_WORKSPACE_DIFF_UNTRACKED_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_WORKSPACE_DIFF_UNTRACKED_FILE_BYTES) {
      return { file: binaryWorkspaceDiffFile(path), patch: "" };
    }
    const text = decodeUtf8(buffer.subarray(0, bytesRead));
    if (text === null) {
      return { file: binaryWorkspaceDiffFile(path), patch: "" };
    }
    const additions = text.length === 0 ? 0 : text.split("\n").length;
    return {
      file: { path, status: "untracked", additions, deletions: 0, binary: false },
      patch: untrackedPatch(path, text),
    };
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      return {
        file: missingUntrackedWorkspaceDiffFile(path),
        patch: "",
      };
    }
    if (codeFromError(err) === "ELOOP") {
      return { file: binaryWorkspaceDiffFile(path), patch: "" };
    }
    throw new WorkspaceDiffError(`untracked file "${path}" is not readable`, { cause: err });
  } finally {
    await handle?.close();
  }
}

async function workingTreeDiffFiles(
  cwd: string,
  repoRoot: string,
): Promise<{
  files: WorkspaceDiffFile[];
  patch: string;
  truncated: boolean;
}> {
  const stagedArgs = ["--cached", ...DIFF_ARGS];
  const unstagedArgs = [...DIFF_ARGS];
  const [stagedFiles, unstagedFiles, stagedPatch, unstagedPatch, untrackedPaths] =
    await Promise.all([
      diffFiles(cwd, stagedArgs),
      diffFiles(cwd, unstagedArgs),
      diffPatch(cwd, stagedArgs),
      diffPatch(cwd, unstagedArgs),
      listUntrackedFiles(cwd),
    ]);
  const files = new Map<string, WorkspaceDiffFile>();
  for (const file of [...stagedFiles, ...unstagedFiles]) {
    addOrMergeFile(files, file);
  }
  const patch: PatchAccumulator = { chunks: [], bytes: 0, truncated: false };
  appendPatch(patch, stagedPatch.stdout.toString("utf8"));
  appendPatch(patch, unstagedPatch.stdout.toString("utf8"));
  patch.truncated ||= stagedPatch.truncated || unstagedPatch.truncated;
  const untrackedFiles = await mapWithConcurrency(
    untrackedPaths.sort((left, right) => left.localeCompare(right)),
    UNTRACKED_FILE_CONCURRENCY,
    (path) => readUntrackedFile(repoRoot, path),
  );
  for (const untracked of untrackedFiles) {
    addOrMergeFile(files, untracked.file);
    appendPatch(patch, untracked.patch);
  }
  return {
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    patch: patch.chunks.join(""),
    truncated: patch.truncated,
  };
}

function diffStats(files: WorkspaceDiffFile[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  };
}

export async function getWorkspaceDiffForRun(
  manifest: Pick<RunManifest, "cwd" | "runId">,
  input: WorkspaceDiffInput,
): Promise<WorkspaceDiff> {
  const cwd = realCwd(manifest);
  const repoRoot = await resolveRepoRoot(cwd);
  if (!isContainedBy(repoRoot, cwd)) {
    throw new WorkspaceDiffError(`workspace cwd for run ${manifest.runId} is outside Git repo`);
  }

  if (input.mode === "working-tree") {
    const result = await workingTreeDiffFiles(cwd, repoRoot);
    return {
      runId: manifest.runId,
      cwd: manifest.cwd,
      repoRoot,
      mode: "working-tree",
      baseRef: null,
      headRef: null,
      comparison: null,
      displayRange: "Working tree",
      files: result.files,
      stats: diffStats(result.files),
      patch: result.patch,
      truncated: result.truncated,
      maxBytes: MAX_WORKSPACE_DIFF_BYTES,
    };
  }

  await Promise.all([
    assertCommitRef(cwd, input.base, "base"),
    assertCommitRef(cwd, input.head, "head"),
  ]);
  const displayRange =
    input.comparison === "merge-base"
      ? `${input.base}...${input.head}`
      : `${input.base}..${input.head}`;
  const args = [...DIFF_ARGS, displayRange];
  const [files, patch] = await Promise.all([diffFiles(cwd, args), diffPatch(cwd, args)]);
  return {
    runId: manifest.runId,
    cwd: manifest.cwd,
    repoRoot,
    mode: "branch",
    baseRef: input.base,
    headRef: input.head,
    comparison: input.comparison,
    displayRange,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    stats: diffStats(files),
    patch: patch.stdout.toString("utf8"),
    truncated: patch.truncated,
    maxBytes: MAX_WORKSPACE_DIFF_BYTES,
  };
}
