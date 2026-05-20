import {
  promises as fs,
  type Stats,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_LIST_ENTRIES,
  MAX_WORKSPACE_SEARCH_RESULTS,
  MAX_WORKSPACE_SEARCH_VISITED,
  type WorkspaceFileContent,
  type WorkspaceFileDirectory,
  type WorkspaceFileEntry,
  type WorkspaceFileMediaType,
  type WorkspaceFileSearch,
} from "../../contracts/workspace-files.js";
import type { RunManifest } from "./manifest.js";

export class WorkspaceFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceFileError";
  }
}

export class WorkspaceFileInvalidPathError extends WorkspaceFileError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileInvalidPathError";
  }
}

export class WorkspaceFileNotFoundError extends WorkspaceFileError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileNotFoundError";
  }
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

function isContainedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length === 0 || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeWorkspacePath(input: string | undefined, opts: { allowRoot: boolean }): string {
  const path = input ?? "";
  if (path.length === 0) {
    if (opts.allowRoot) {
      return "";
    }
    throw new WorkspaceFileInvalidPathError("workspace file path cannot be empty");
  }
  if (isAbsolute(path) || path.includes("\\")) {
    throw new WorkspaceFileInvalidPathError(`invalid workspace path "${path}"`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new WorkspaceFileInvalidPathError(`invalid workspace path "${path}"`);
  }
  return segments.join("/");
}

function relativeWorkspacePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function realCwd(manifest: Pick<RunManifest, "cwd" | "runId">): string {
  try {
    return realpathSync(manifest.cwd);
  } catch (err) {
    throw new WorkspaceFileError(`workspace cwd for run ${manifest.runId} is not readable`, {
      cause: err,
    });
  }
}

function resolveWorkspaceTarget(
  manifest: Pick<RunManifest, "cwd" | "runId">,
  inputPath: string | undefined,
  opts: { allowRoot: boolean },
): { root: string; path: string; absolutePath: string; realPath: string } {
  const path = normalizeWorkspacePath(inputPath, opts);
  const root = realCwd(manifest);
  const absolutePath = resolve(root, path);
  if (!isContainedBy(root, absolutePath)) {
    throw new WorkspaceFileInvalidPathError(`workspace path "${path}" escapes cwd`);
  }
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      throw new WorkspaceFileNotFoundError(`workspace path "${path}" not found`);
    }
    throw new WorkspaceFileError(`workspace path "${path}" is not readable`, { cause: err });
  }
  if (!isContainedBy(root, realPath)) {
    throw new WorkspaceFileInvalidPathError(`workspace path "${path}" resolves outside cwd`);
  }
  return { root, path, absolutePath, realPath };
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

function shouldSkipSearchDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "node_modules" ||
    normalized === ".git" ||
    normalized === ".hg" ||
    normalized === ".svn"
  );
}

function codeFromError(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : null;
}

function realpathWorkspaceChild(displayPath: string, absolutePath: string): string {
  try {
    return realpathSync(absolutePath);
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      throw new WorkspaceFileNotFoundError(`workspace path "${displayPath}" not found`);
    }
    throw new WorkspaceFileError(`workspace path "${displayPath}" is not readable`, {
      cause: err,
    });
  }
}

function statWorkspacePath(displayPath: string, path: string) {
  try {
    return statSync(path);
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      throw new WorkspaceFileNotFoundError(`workspace path "${displayPath}" not found`);
    }
    throw new WorkspaceFileError(`workspace path "${displayPath}" is not readable`, {
      cause: err,
    });
  }
}

function readWorkspaceFileBuffer(displayPath: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      throw new WorkspaceFileNotFoundError(`workspace path "${displayPath}" not found`);
    }
    throw new WorkspaceFileError(`workspace file "${displayPath}" is not readable`, {
      cause: err,
    });
  }
}

async function asyncWorkspaceFs<T>(displayPath: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      throw new WorkspaceFileNotFoundError(`workspace path "${displayPath}" not found`);
    }
    throw new WorkspaceFileError(`workspace path "${displayPath}" is not readable`, {
      cause: err,
    });
  }
}

function entryFromStats(stats: Stats, displayPath: string): WorkspaceFileEntry {
  const kind = stats.isDirectory() ? "directory" : "file";
  return {
    path: displayPath,
    name: basename(displayPath),
    kind,
    size: kind === "file" ? stats.size : null,
    mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null,
    supportedText: kind === "file" && stats.isFile() && stats.size <= MAX_WORKSPACE_FILE_BYTES,
    markdown: kind === "file" && isMarkdownPath(displayPath),
  };
}

function entryForPath(realPath: string, displayPath: string): WorkspaceFileEntry {
  return entryFromStats(statWorkspacePath(displayPath, realPath), displayPath);
}

function parentPathFor(path: string): string | null {
  if (path.length === 0) {
    return null;
  }
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function listWorkspaceFiles(
  manifest: Pick<RunManifest, "cwd" | "runId">,
  input: { path?: string } = {},
): WorkspaceFileDirectory {
  const target = resolveWorkspaceTarget(manifest, input.path, { allowRoot: true });
  const stats = statWorkspacePath(target.path, target.realPath);
  if (!stats.isDirectory()) {
    throw new WorkspaceFileError(`workspace path "${target.path}" is not a directory`);
  }

  let names: string[];
  try {
    names = readdirSync(target.realPath);
  } catch (err) {
    throw new WorkspaceFileError(`workspace directory "${target.path}" is not readable`, {
      cause: err,
    });
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (entries.length >= MAX_WORKSPACE_LIST_ENTRIES) {
      break;
    }
    const displayPath = target.path.length > 0 ? `${target.path}/${name}` : name;
    const absolutePath = resolve(target.realPath, name);
    const realPath = realpathWorkspaceChild(displayPath, absolutePath);
    if (!isContainedBy(target.root, realPath)) {
      throw new WorkspaceFileInvalidPathError(
        `workspace path "${displayPath}" resolves outside cwd`,
      );
    }
    entries.push(entryForPath(realPath, displayPath));
  }

  return {
    runId: manifest.runId,
    cwd: manifest.cwd,
    path: target.path,
    parentPath: parentPathFor(target.path),
    entries,
    truncated: names.length > entries.length,
    maxEntries: MAX_WORKSPACE_LIST_ENTRIES,
  };
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function decodeUtf8(buffer: Buffer, path: string): string {
  if (hasNulByte(buffer)) {
    throw new WorkspaceFileError(`workspace file "${path}" is binary`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (err) {
    throw new WorkspaceFileError(`workspace file "${path}" is not valid UTF-8`, { cause: err });
  }
}

export function readWorkspaceFile(
  manifest: Pick<RunManifest, "cwd" | "runId">,
  input: { path: string },
): WorkspaceFileContent {
  const target = resolveWorkspaceTarget(manifest, input.path, { allowRoot: false });
  const stats = statWorkspacePath(target.path, target.realPath);
  if (!stats.isFile()) {
    throw new WorkspaceFileError(`workspace path "${target.path}" is not a file`);
  }
  if (stats.size > MAX_WORKSPACE_FILE_BYTES) {
    throw new WorkspaceFileError(
      `workspace file "${target.path}" exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes`,
    );
  }
  const buffer = readWorkspaceFileBuffer(target.path, target.realPath);
  const text = decodeUtf8(buffer, target.path);
  const markdown = isMarkdownPath(target.path);
  const mediaType: WorkspaceFileMediaType = markdown ? "text/markdown" : "text/plain";
  return {
    runId: manifest.runId,
    cwd: manifest.cwd,
    path: target.path,
    name: basename(target.path),
    size: stats.size,
    mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null,
    mediaType,
    markdown,
    text,
    maxBytes: MAX_WORKSPACE_FILE_BYTES,
  };
}

export async function searchWorkspaceFiles(
  manifest: Pick<RunManifest, "cwd" | "runId">,
  input: { query: string; limit?: number },
): Promise<WorkspaceFileSearch> {
  const query = input.query.trim();
  if (query.length === 0) {
    throw new WorkspaceFileInvalidPathError("workspace search query cannot be empty");
  }
  const maxResults = Math.min(
    input.limit ?? MAX_WORKSPACE_SEARCH_RESULTS,
    MAX_WORKSPACE_SEARCH_RESULTS,
  );
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new WorkspaceFileInvalidPathError("workspace search limit must be a positive integer");
  }

  const root = realCwd(manifest);
  const needle = query.toLowerCase();
  const matches: WorkspaceFileEntry[] = [];
  let truncated = false;
  const pending = [root];
  let visited = 0;

  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) {
      break;
    }
    if (visited >= MAX_WORKSPACE_SEARCH_VISITED) {
      truncated = true;
      break;
    }
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (err) {
      throw new WorkspaceFileError("workspace search failed while reading directory", {
        cause: err,
      });
    }
    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      if (visited >= MAX_WORKSPACE_SEARCH_VISITED) {
        truncated = true;
        break;
      }
      const absolutePath = resolve(directory, name);
      const displayPath = relativeWorkspacePath(root, absolutePath);
      const stats = await asyncWorkspaceFs(displayPath, () => fs.lstat(absolutePath));
      if (stats.isDirectory() && shouldSkipSearchDirectory(name)) {
        continue;
      }
      visited += 1;
      const realPath = await asyncWorkspaceFs(displayPath, () => fs.realpath(absolutePath));
      if (!isContainedBy(root, realPath)) {
        throw new WorkspaceFileInvalidPathError(
          `workspace path "${displayPath}" resolves outside cwd`,
        );
      }
      if (displayPath.toLowerCase().includes(needle)) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
        const realStats = await asyncWorkspaceFs(displayPath, () => fs.stat(realPath));
        matches.push(entryFromStats(realStats, displayPath));
      }
      if (stats.isDirectory()) {
        pending.push(absolutePath);
      }
    }
    if (truncated) {
      break;
    }
  }

  return {
    runId: manifest.runId,
    cwd: manifest.cwd,
    query,
    matches,
    truncated,
    maxResults,
  };
}
