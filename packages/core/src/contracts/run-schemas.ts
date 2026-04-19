import { z } from "zod";
import { LOCKABLE_FIELDS } from "../core/config/schema.js";
import type { AttachmentListEntry, RunAttachment } from "./attachments.js";
import type {
  RunDetailStreamEvent,
  RunSummaryStreamEvent,
  RunTimelineAttempt,
  RunTimelineEnvelope,
  RunTimelineEvent,
  RunTimelineHistory,
} from "./events.js";
import type {
  RunAbortReason,
  RunActiveTask,
  RunArchiveResult,
  RunBackendSessionResult,
  RunCapabilities,
  RunDeleteResult,
  RunDependenciesResult,
  RunDependencyDetail,
  RunDependencyState,
  RunDetail,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
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

export const runActiveTaskSchema: z.ZodType<RunActiveTask> = z.object({
  id: z.string(),
  title: z.string(),
});

export const runTaskMutationCapabilitiesSchema: z.ZodType<RunTaskMutationCapabilities> = z.object({
  canSetStatus: z.boolean(),
  canEditNotes: z.boolean(),
  canAdd: z.boolean(),
});

const runExecutionSchema = z
  .object({
    hostMode: z.enum(["embedded", "daemon"]),
    controller: z.union([
      z.object({
        kind: z.literal("embedded"),
      }),
      z.object({
        kind: z.literal("daemon"),
        daemonInstanceId: z.string(),
      }),
    ]),
  })
  .refine((value) => value.hostMode === value.controller.kind, {
    message: "execution.hostMode must match execution.controller.kind",
  });

const runAbortReasonSchema: z.ZodType<RunAbortReason> = z.enum([
  "already_terminal",
  "not_active_in_daemon",
]);

export const runCapabilitiesSchema: z.ZodType<RunCapabilities> = z.object({
  canArchive: z.boolean(),
  canUnarchive: z.boolean(),
  canReset: z.boolean(),
  canDelete: z.boolean(),
  canResume: z.boolean(),
  canAbort: z.boolean(),
  abortReason: runAbortReasonSchema.optional(),
  taskMutation: runTaskMutationCapabilitiesSchema,
});

const runAttachmentObjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  sha256: z.string(),
  addedAt: z.string(),
  relativePath: z.string(),
});

export const runAttachmentSchema: z.ZodType<RunAttachment> = runAttachmentObjectSchema;

export const attachmentListEntrySchema: z.ZodType<AttachmentListEntry> =
  runAttachmentObjectSchema.extend({
    ownerRunId: z.string(),
  });

export const runDependencyStateSchema: z.ZodType<RunDependencyState> = z.object({
  ready: z.boolean(),
  total: z.number(),
  satisfied: z.number(),
  unsatisfied: z.number(),
});

export const runDependencyDetailSchema: z.ZodType<RunDependencyDetail> = z.object({
  runId: z.string(),
  name: z.string().nullable(),
  status: runStatusSchema.nullable(),
  effectiveStatus: runStatusSchema.nullable(),
  archivedAt: z.string().nullable(),
  satisfied: z.boolean(),
  missing: z.boolean(),
});

export const runSummarySchema: z.ZodType<RunSummary> = z.object({
  runId: z.string(),
  repo: z.string(),
  status: runStatusSchema,
  effectiveStatus: runStatusSchema,
  archivedAt: z.string().nullable(),
  pinned: z.boolean(),
  notePresent: z.boolean(),
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
  attachmentCount: z.number(),
  dependencyState: runDependencyStateSchema,
  activeTask: runActiveTaskSchema.nullable(),
  execution: runExecutionSchema,
  capabilities: runCapabilitiesSchema,
});

export const runDetailSchema: z.ZodType<RunDetail> = z.object({
  runId: z.string(),
  repo: z.string(),
  status: runStatusSchema,
  effectiveStatus: runStatusSchema,
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
  note: z.string().nullable(),
  pinned: z.boolean(),
  backendSessionId: z.string().nullable(),
  cwd: z.string(),
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
  attachments: z.array(runAttachmentSchema),
  dependencies: z.array(runDependencyDetailSchema),
  dependents: z.array(runDependencyDetailSchema),
  tasks: z.array(runTaskSummarySchema),
  activeTask: runActiveTaskSchema.nullable(),
  message: z.string().nullable(),
  pendingPrompt: z.string().nullable(),
  callerInstructions: z.string().nullable(),
  lockedFields: z.array(z.enum(LOCKABLE_FIELDS)),
  runtimeVars: z.record(z.string(), z.unknown()),
  execution: runExecutionSchema,
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

export const runNoteResultSchema: z.ZodType<RunNoteResult> = z.object({
  runId: z.string(),
  note: z.string().nullable(),
  changed: z.boolean(),
});

export const runPinnedResultSchema: z.ZodType<RunPinnedResult> = z.object({
  runId: z.string(),
  pinned: z.boolean(),
  changed: z.boolean(),
});

export const runBackendSessionResultSchema: z.ZodType<RunBackendSessionResult> = z.object({
  runId: z.string(),
  backendSessionId: z.string().nullable(),
  changed: z.boolean(),
});

export const runDependenciesResultSchema: z.ZodType<RunDependenciesResult> = z.object({
  runId: z.string(),
  dependencyRunIds: z.array(z.string()),
  changed: z.boolean(),
});

export const runDeleteResultSchema: z.ZodType<RunDeleteResult> = z.object({
  runId: z.string(),
});

export const runSummaryStreamEventSchema: z.ZodType<RunSummaryStreamEvent> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("summary_upsert"),
      summary: runSummarySchema,
    }),
    z.object({
      type: z.literal("summary_removed"),
      runId: z.string(),
    }),
  ],
);

export const runDetailStreamEventSchema: z.ZodType<RunDetailStreamEvent> = z.object({
  type: z.literal("detail_updated"),
  detail: runDetailSchema,
});

export const runTimelineEventSchema = z
  .object({
    type: z.string(),
  })
  .passthrough() as z.ZodType<RunTimelineEvent>;

export const runTimelineAttemptSchema: z.ZodType<RunTimelineAttempt> = z.object({
  attempt: z.number().int().positive(),
  sessionIndex: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  prompt: z.string(),
  transcript: z.string(),
  notices: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  live: z.boolean(),
});

export const runTimelineHistorySchema: z.ZodType<RunTimelineHistory> = z.object({
  runId: z.string(),
  attempts: z.array(runTimelineAttemptSchema),
  lastCursor: z.number().int().nonnegative(),
});

export const runTimelineEnvelopeSchema: z.ZodType<RunTimelineEnvelope> = z.object({
  runId: z.string(),
  cursor: z.number().int().positive(),
  event: runTimelineEventSchema,
});
