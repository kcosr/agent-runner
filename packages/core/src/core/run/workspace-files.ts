import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_LIST_ENTRIES,
  MAX_WORKSPACE_SEARCH_RESULTS,
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

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".sh",
  ".text",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

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

function isSupportedTextPath(path: string): boolean {
  return isMarkdownPath(path) || TEXT_EXTENSIONS.has(extname(path).toLowerCase());
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

function lstatWorkspacePath(displayPath: string, path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (codeFromError(err) === "ENOENT") {
      throw new WorkspaceFileNotFoundError(`workspace path "${displayPath}" not found`);
    }
    throw new WorkspaceFileError(`workspace path "${displayPath}" is not readable`, {
      cause: err,
    });
  }
}

function entryForPath(realPath: string, displayPath: string): WorkspaceFileEntry {
  const stats = statWorkspacePath(displayPath, realPath);
  const kind = stats.isDirectory() ? "directory" : "file";
  return {
    path: displayPath,
    name: basename(displayPath),
    kind,
    size: kind === "file" ? stats.size : null,
    mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null,
    supportedText: kind === "file" && isSupportedTextPath(displayPath),
    markdown: kind === "file" && isMarkdownPath(displayPath),
  };
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
  const buffer = readFileSync(target.realPath);
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

export function searchWorkspaceFiles(
  manifest: Pick<RunManifest, "cwd" | "runId">,
  input: { query: string; limit?: number },
): WorkspaceFileSearch {
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

  while (pending.length > 0) {
    const directory = pending.shift();
    if (directory === undefined) {
      break;
    }
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (err) {
      throw new WorkspaceFileError("workspace search failed while reading directory", {
        cause: err,
      });
    }
    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      const absolutePath = resolve(directory, name);
      const displayPath = relativeWorkspacePath(root, absolutePath);
      const realPath = realpathWorkspaceChild(displayPath, absolutePath);
      if (!isContainedBy(root, realPath)) {
        throw new WorkspaceFileInvalidPathError(
          `workspace path "${displayPath}" resolves outside cwd`,
        );
      }
      const stats = lstatWorkspacePath(displayPath, absolutePath);
      if (displayPath.toLowerCase().includes(needle)) {
        if (matches.length >= maxResults) {
          truncated = true;
          return {
            runId: manifest.runId,
            cwd: manifest.cwd,
            query,
            matches,
            truncated,
            maxResults,
          };
        }
        matches.push(entryForPath(realPath, displayPath));
      }
      if (stats.isDirectory()) {
        pending.push(absolutePath);
      }
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
