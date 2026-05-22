import { z } from "zod";

export const MAX_WORKSPACE_DIFF_BYTES = 512 * 1024;
export const MAX_WORKSPACE_DIFF_UNTRACKED_FILE_BYTES = 64 * 1024;
export const WORKSPACE_DIFF_TIMEOUT_MS = 10_000;

export type WorkspaceDiffMode = "branch" | "working-tree";
export type WorkspaceDiffComparison = "merge-base" | "direct";
export type WorkspaceDiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "binary";

export interface WorkspaceBranchDiffInput {
  mode: "branch";
  base: string;
  head: string;
  comparison: WorkspaceDiffComparison;
}

export interface WorkspaceWorkingTreeDiffInput {
  mode: "working-tree";
}

export type WorkspaceDiffInput = WorkspaceBranchDiffInput | WorkspaceWorkingTreeDiffInput;

export interface WorkspaceDiffFile {
  path: string;
  oldPath?: string;
  status: WorkspaceDiffFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface WorkspaceDiff {
  runId: string;
  cwd: string;
  repoRoot: string;
  mode: WorkspaceDiffMode;
  baseRef: string | null;
  headRef: string | null;
  comparison: WorkspaceDiffComparison | null;
  displayRange: string;
  files: WorkspaceDiffFile[];
  stats: { files: number; additions: number; deletions: number };
  patch: string;
  truncated: boolean;
  maxBytes: number;
}

export interface WorkspaceDiffResponse {
  diff: WorkspaceDiff;
}

export const workspaceDiffModeSchema = z.enum(["branch", "working-tree"]);
export const workspaceDiffComparisonSchema = z.enum(["merge-base", "direct"]);
export const workspaceDiffFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "binary",
]);

export const workspaceDiffFileSchema: z.ZodType<WorkspaceDiffFile> = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: workspaceDiffFileStatusSchema,
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});

export const workspaceDiffResponseSchema: z.ZodType<WorkspaceDiffResponse> = z.object({
  diff: z.object({
    runId: z.string(),
    cwd: z.string(),
    repoRoot: z.string(),
    mode: workspaceDiffModeSchema,
    baseRef: z.string().nullable(),
    headRef: z.string().nullable(),
    comparison: workspaceDiffComparisonSchema.nullable(),
    displayRange: z.string(),
    files: z.array(workspaceDiffFileSchema),
    stats: z.object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
    patch: z.string(),
    truncated: z.boolean(),
    maxBytes: z.number().int().positive(),
  }),
});
