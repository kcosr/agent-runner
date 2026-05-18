import { z } from "zod";

export const MAX_WORKSPACE_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_WORKSPACE_LIST_ENTRIES = 1000;
export const MAX_WORKSPACE_SEARCH_RESULTS = 200;
export const MAX_WORKSPACE_SEARCH_VISITED = 5000;

export type WorkspaceFileKind = "directory" | "file";
export type WorkspaceFileMediaType = "text/markdown" | "text/plain";

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  size: number | null;
  mtimeMs: number | null;
  supportedText: boolean;
  markdown: boolean;
}

export interface WorkspaceFileDirectory {
  runId: string;
  cwd: string;
  path: string;
  parentPath: string | null;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  maxEntries: number;
}

export interface WorkspaceFileListResponse {
  directory: WorkspaceFileDirectory;
}

export interface WorkspaceFileSearch {
  runId: string;
  cwd: string;
  query: string;
  matches: WorkspaceFileEntry[];
  truncated: boolean;
  maxResults: number;
}

export interface WorkspaceFileSearchResponse {
  search: WorkspaceFileSearch;
}

export interface WorkspaceFileContent {
  runId: string;
  cwd: string;
  path: string;
  name: string;
  size: number;
  mtimeMs: number | null;
  mediaType: WorkspaceFileMediaType;
  markdown: boolean;
  text: string;
  maxBytes: number;
}

export interface WorkspaceFileReadResponse {
  file: WorkspaceFileContent;
}

export const workspaceFileEntrySchema: z.ZodType<WorkspaceFileEntry> = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["directory", "file"]),
  size: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number().nonnegative().nullable(),
  supportedText: z.boolean(),
  markdown: z.boolean(),
});

export const workspaceFileListResponseSchema: z.ZodType<WorkspaceFileListResponse> = z.object({
  directory: z.object({
    runId: z.string(),
    cwd: z.string(),
    path: z.string(),
    parentPath: z.string().nullable(),
    entries: z.array(workspaceFileEntrySchema),
    truncated: z.boolean(),
    maxEntries: z.number().int().positive(),
  }),
});

export const workspaceFileSearchResponseSchema: z.ZodType<WorkspaceFileSearchResponse> = z.object({
  search: z.object({
    runId: z.string(),
    cwd: z.string(),
    query: z.string(),
    matches: z.array(workspaceFileEntrySchema),
    truncated: z.boolean(),
    maxResults: z.number().int().positive(),
  }),
});

export const workspaceFileReadResponseSchema: z.ZodType<WorkspaceFileReadResponse> = z.object({
  file: z.object({
    runId: z.string(),
    cwd: z.string(),
    path: z.string(),
    name: z.string(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative().nullable(),
    mediaType: z.enum(["text/markdown", "text/plain"]),
    markdown: z.boolean(),
    text: z.string(),
    maxBytes: z.number().int().positive(),
  }),
});
