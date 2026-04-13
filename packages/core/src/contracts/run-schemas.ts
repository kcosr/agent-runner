import { z } from "zod";
import { LOCKABLE_FIELDS, TASK_MODES } from "../core/config/schema.js";
import type {
  RunArchiveResult,
  RunCapabilities,
  RunDetail,
  RunNameResult,
  RunStatus,
  RunSummary,
  RunTaskMutationCapabilities,
  RunTaskSummary,
} from "./runs.js";

const RUN_STATUSES = [
  "initialized",
  "running",
  "success",
  "blocked",
  "exhausted",
  "aborted",
  "error",
] as const;

const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;

export const runStatusSchema: z.ZodType<RunStatus> = z.enum(RUN_STATUSES);

export const runTaskSummarySchema: z.ZodType<RunTaskSummary> = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(TASK_STATUSES),
  notes: z.string(),
});

export const runTaskMutationCapabilitiesSchema: z.ZodType<RunTaskMutationCapabilities> = z.object({
  canSetStatus: z.boolean(),
  canEditNotes: z.boolean(),
  canAdd: z.boolean(),
});

export const runCapabilitiesSchema: z.ZodType<RunCapabilities> = z.object({
  canArchive: z.boolean(),
  canUnarchive: z.boolean(),
  canResume: z.boolean(),
  taskMutation: runTaskMutationCapabilitiesSchema,
});

export const runSummarySchema: z.ZodType<RunSummary> = z.object({
  runId: z.string(),
  repo: z.string(),
  status: runStatusSchema,
  archivedAt: z.string().nullable(),
  agentName: z.string(),
  name: z.string().nullable(),
  assignmentName: z.string().nullable(),
  backend: z.string(),
  model: z.string().nullable(),
  cwd: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  tasksCompleted: z.number(),
  tasksTotal: z.number(),
  capabilities: runCapabilitiesSchema,
});

export const runDetailSchema: z.ZodType<RunDetail> = z.object({
  runId: z.string(),
  repo: z.string(),
  status: runStatusSchema,
  archivedAt: z.string().nullable(),
  isLive: z.boolean(),
  workspaceDir: z.string(),
  assignmentPath: z.string(),
  agent: z.object({
    name: z.string(),
    sourcePath: z.string().nullable(),
  }),
  assignment: z
    .object({
      name: z.string(),
      sourcePath: z.string(),
      workspacePath: z.string(),
    })
    .nullable(),
  backend: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  name: z.string().nullable(),
  backendSessionId: z.string().nullable(),
  cwd: z.string(),
  taskMode: z.enum(TASK_MODES),
  unrestricted: z.boolean(),
  timeoutSec: z.number(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  attempts: z.number(),
  maxAttempts: z.number(),
  sessionCount: z.number(),
  tasksCompleted: z.number(),
  tasksTotal: z.number(),
  tasks: z.array(runTaskSummarySchema),
  message: z.string().nullable(),
  callerInstructions: z.string().nullable(),
  pendingPrompt: z.string().nullable(),
  lockedFields: z.array(z.enum(LOCKABLE_FIELDS)),
  runtimeVars: z.record(z.string(), z.unknown()),
  capabilities: runCapabilitiesSchema,
});

export const runArchiveResultSchema: z.ZodType<RunArchiveResult> = z.object({
  runId: z.string(),
  status: runStatusSchema,
  archivedAt: z.string().nullable(),
  changed: z.boolean(),
});

export const runNameResultSchema: z.ZodType<RunNameResult> = z.object({
  runId: z.string(),
  name: z.string().nullable(),
  changed: z.boolean(),
});
