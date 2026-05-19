import { z } from "zod";
import { LOCKABLE_FIELDS } from "../core/config/schema.js";
import { HOOK_PHASES } from "../core/config/schema.js";
import type { AttachmentListEntry, RunAttachment } from "./attachments.js";
import type {
  RunAuditEnvelope,
  RunAuditEvent,
  RunAuditHistory,
  RunDetailStreamEvent,
  RunSummaryStreamEvent,
  RunTimelineAttempt,
  RunTimelineEnvelope,
  RunTimelineEvent,
  RunTimelineHistory,
} from "./events.js";
import type {
  QueueResumeMessageResult,
  QueuedResumeMessage,
  RemoveQueuedResumeMessageResult,
  RunAbortReason,
  RunActiveTask,
  RunArchiveResult,
  RunBackendSessionResult,
  RunCapabilities,
  RunDeleteResult,
  RunDependenciesResult,
  RunDependencyDetail,
  RunDependencyRef,
  RunDependencyState,
  RunDependentDetail,
  RunDetail,
  RunGroupResult,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunReconfigureUnavailableReason,
  RunSchedule,
  RunScheduleState,
  RunSessionSummary,
  RunStatus,
  RunSummary,
  RunTaskDeleteResult,
  RunTaskMutationCapabilities,
  RunTaskSummary,
} from "./runs.js";

const RUN_STATUSES = [
  "initialized",
  "ready",
  "running",
  "success",
  "blocked",
  "exhausted",
  "aborted",
  "error",
] as const;

const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
const RUN_SCHEDULE_STATES = ["none", "paused", "future", "due"] as const;

export const runStatusSchema: z.ZodType<RunStatus> = z.enum(RUN_STATUSES);

export const runScheduleStateSchema: z.ZodType<RunScheduleState> = z.enum(RUN_SCHEDULE_STATES);

const runScheduleModeSchema = z.enum(["reuse", "reset", "clone"]);
const runEnvironmentMountSchema = z.object({
  hostPath: z.string(),
  containerPath: z.string(),
  mode: z.enum(["ro", "rw"]),
});
const runEnvironmentLifecycleTimeoutSchema = z.number().int().positive().nullable();
const runEnvironmentLifecycleStepSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("command"),
      target: z.enum(["host", "container"]),
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
      cwd: z.string().nullable(),
      timeoutMs: runEnvironmentLifecycleTimeoutSchema,
      user: z.string().nullable(),
      detach: z.boolean(),
    }),
    z.object({
      kind: z.literal("git-clone"),
      target: z.enum(["host", "container"]),
      source: z.string(),
      baseRef: z.string(),
      branch: z.string(),
      timeoutMs: runEnvironmentLifecycleTimeoutSchema,
    }),
  ])
  .refine(
    (step) =>
      step.kind !== "command" ||
      step.target !== "host" ||
      (step.user === null && step.detach === false),
    {
      path: ["target"],
      message: "host lifecycle command steps cannot set user or detach",
    },
  );
const runEnvironmentAfterStartLifecycleSchema = z.object({
  steps: z.array(runEnvironmentLifecycleStepSchema),
  completedContainerId: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
const runEnvironmentOnWorkspaceCreateLifecycleSchema = z.object({
  steps: z.array(runEnvironmentLifecycleStepSchema),
  completedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
const runEnvironmentLifecycleSchema = z.object({
  afterStart: runEnvironmentAfterStartLifecycleSchema.nullable(),
  onWorkspaceCreate: runEnvironmentOnWorkspaceCreateLifecycleSchema.nullable(),
});
const runEnvironmentWorkspaceSchema = runEnvironmentMountSchema.extend({
  scope: z.enum(["run", "group"]),
  hostRoot: z.string().nullable(),
  create: z.boolean(),
  createdAt: z.string().nullable(),
});
const runExecutionEnvironmentBaseSchema = z.object({
  kind: z.literal("container"),
  name: z.string().nullable(),
  sourcePath: z.string().nullable(),
  engine: z.enum(["docker", "podman"]),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  extraExecArgs: z.array(z.string()),
  lastValidatedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
const runExistingContainerEnvironmentSchema = runExecutionEnvironmentBaseSchema.extend({
  mode: z.literal("existing"),
  container: z.string(),
  containerIdAtValidation: z.string().nullable(),
  expectedMounts: z.array(runEnvironmentMountSchema),
});
const runManagedContainerEnvironmentSchema = runExecutionEnvironmentBaseSchema.extend({
  mode: z.literal("managed"),
  image: z.string(),
  lifetime: z.enum(["run", "group"]),
  containerName: z.string(),
  containerId: z.string().nullable(),
  workspace: runEnvironmentWorkspaceSchema.nullable(),
  lifecycle: runEnvironmentLifecycleSchema.nullable(),
  sessionMounts: z.array(
    runEnvironmentMountSchema.extend({
      preset: z.enum(["claude", "codex", "cursor", "opencode", "pi"]),
    }),
  ),
  mounts: z.array(runEnvironmentMountSchema),
  network: z.string(),
  security: z.object({
    userns: z.enum(["keep-id", "host"]).optional(),
    selinuxLabel: z.enum(["disable", "shared", "private"]).optional(),
    readOnlyRootFilesystem: z.boolean().optional(),
    capDrop: z.array(z.string()),
    capAdd: z.array(z.string()),
  }),
  extraRunArgs: z.array(z.string()),
  cleanup: z.object({
    policy: z.enum(["terminal", "manual"]),
    cleanedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
});
const runExecutionEnvironmentSchema: z.ZodType<RunDetail["executionEnvironment"]> = z
  .discriminatedUnion("mode", [
    runExistingContainerEnvironmentSchema,
    runManagedContainerEnvironmentSchema,
  ])
  .nullable()
  .refine(
    (environment) =>
      environment === null ||
      environment.mode !== "managed" ||
      environment.workspace !== null ||
      environment.lifecycle?.onWorkspaceCreate == null,
    {
      path: ["lifecycle", "onWorkspaceCreate"],
      message: "lifecycle.onWorkspaceCreate requires workspace",
    },
  );

export const runScheduleSchema: z.ZodType<RunSchedule> = z.object({
  enabled: z.boolean(),
  runAt: z.string(),
  recurrence: z
    .object({
      schedule: z.object({
        type: z.literal("cron"),
        expression: z.string(),
        timezone: z.string(),
      }),
      mode: runScheduleModeSchema,
      continueOnFailure: z.boolean(),
    })
    .nullable(),
});

export const runTaskSummarySchema: z.ZodType<RunTaskSummary> = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(TASK_STATUSES),
  notes: z.string(),
});

export const runTaskDeleteResultSchema: z.ZodType<RunTaskDeleteResult> = z.object({
  runId: z.string(),
  taskId: z.string(),
  deleted: z.literal(true),
  updatedAt: z.string(),
});

export const runActiveTaskSchema: z.ZodType<RunActiveTask> = z.object({
  id: z.string(),
  title: z.string(),
});

export const runTaskMutationCapabilitiesSchema: z.ZodType<RunTaskMutationCapabilities> = z.object({
  canSetStatus: z.boolean(),
  canEditNotes: z.boolean(),
  canAdd: z.boolean(),
  canEditPending: z.boolean(),
  canDeletePending: z.boolean(),
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
const runReconfigureUnavailableReasonSchema: z.ZodType<RunReconfigureUnavailableReason> = z.enum([
  "archived",
  "not_initialized",
]);

export const runCapabilitiesSchema: z.ZodType<RunCapabilities> = z.object({
  canArchive: z.boolean(),
  canUnarchive: z.boolean(),
  canReset: z.boolean(),
  canDelete: z.boolean(),
  canReady: z.boolean(),
  canResume: z.boolean(),
  canAbort: z.boolean(),
  abortReason: runAbortReasonSchema.optional(),
  canReconfigure: z.boolean(),
  reconfigureReason: runReconfigureUnavailableReasonSchema.optional(),
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

export const queuedResumeMessageSchema: z.ZodType<QueuedResumeMessage> = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

const resolvedHookSourceSchema = z
  .object({
    builtin: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
  })
  .strict();

const resolvedHookDescriptorSchema = z.object({
  hookId: z.string(),
  phase: z.enum(HOOK_PHASES),
  source: resolvedHookSourceSchema,
  resolvedPath: z.string().nullable(),
  taskScopeId: z.string().nullable(),
  when: z.record(z.string(), z.unknown()).nullable(),
  config: z.any(),
});

const hookAuditRecordSchema = z.object({
  phase: z.enum(HOOK_PHASES),
  hookId: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  outcome: z.string(),
  sessionIndex: z.number().nullable(),
  attemptNumber: z.number().nullable(),
  taskId: z.string().nullable(),
  summary: z.string().nullable(),
});

const runSessionSummarySchema: z.ZodType<RunSessionSummary> = z.object({
  sessionIndex: z.number(),
  status: runStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  message: z.string().nullable(),
  firstAttemptNumber: z.number().nullable(),
  lastAttemptNumber: z.number().nullable(),
  attemptCount: z.number(),
  maxAttemptsPerSession: z.number(),
  backendSessionIdAtStart: z.string().nullable(),
  backendSessionIdAtEnd: z.string().nullable(),
});

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

export const runDependencyRefSchema: z.ZodType<RunDependencyRef> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run"),
    runId: z.string(),
  }),
  z.object({
    type: z.literal("group"),
    groupId: z.string(),
  }),
]);

const runDependencyRunDetailSchema = z.object({
  type: z.literal("run"),
  runId: z.string(),
  name: z.string().nullable(),
  status: runStatusSchema.nullable(),
  effectiveStatus: runStatusSchema.nullable(),
  archivedAt: z.string().nullable(),
  satisfied: z.boolean(),
  missing: z.boolean(),
});

export const runDependencyDetailSchema: z.ZodType<RunDependencyDetail> = z.discriminatedUnion(
  "type",
  [
    runDependencyRunDetailSchema,
    z.object({
      type: z.literal("group"),
      groupId: z.string(),
      total: z.number(),
      successful: z.number(),
      unsatisfied: z.number(),
      archivedExcluded: z.number(),
      satisfied: z.boolean(),
      missing: z.boolean(),
    }),
  ],
);

export const runDependentDetailSchema: z.ZodType<RunDependentDetail> = z.discriminatedUnion("via", [
  runDependencyRunDetailSchema.extend({
    via: z.literal("run"),
  }),
  runDependencyRunDetailSchema.extend({
    via: z.literal("group"),
    dependencyGroupId: z.string(),
  }),
]);

export const runSummarySchema: z.ZodType<RunSummary> = z.object({
  runId: z.string(),
  parentRunId: z.string().nullable(),
  runGroupId: z.string(),
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
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  totalAttemptCount: z.number(),
  totalSessionCount: z.number(),
  maxAttemptsPerSession: z.number(),
  currentSession: runSessionSummarySchema.nullable(),
  lastSession: runSessionSummarySchema.nullable(),
  tasksCompleted: z.number(),
  tasksTotal: z.number(),
  attachmentCount: z.number(),
  queuedResumeMessageCount: z.number(),
  hookCount: z.number().optional(),
  dependencyState: runDependencyStateSchema,
  schedule: runScheduleSchema.nullable(),
  scheduleState: runScheduleStateSchema,
  activeTask: runActiveTaskSchema.nullable(),
  execution: runExecutionSchema,
  capabilities: runCapabilitiesSchema,
});

export const runDetailSchema: z.ZodType<RunDetail> = z.object({
  runId: z.string(),
  parentRunId: z.string().nullable(),
  runGroupId: z.string(),
  repo: z.string(),
  status: runStatusSchema,
  effectiveStatus: runStatusSchema,
  archivedAt: z.string().nullable(),
  isLive: z.boolean(),
  workspaceDir: z.string(),
  agent: z.object({
    name: z.string(),
    sourcePath: z.string().nullable(),
  }),
  assignment: z
    .object({
      name: z.string(),
      sourcePath: z.string(),
    })
    .strict()
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
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  totalAttemptCount: z.number(),
  totalSessionCount: z.number(),
  maxAttemptsPerSession: z.number(),
  sessions: z.array(runSessionSummarySchema),
  currentSession: runSessionSummarySchema.nullable(),
  lastSession: runSessionSummarySchema.nullable(),
  tasksCompleted: z.number(),
  tasksTotal: z.number(),
  attachments: z.array(runAttachmentSchema),
  queuedResumeMessages: z.array(queuedResumeMessageSchema),
  resolvedHooks: (
    z.array(resolvedHookDescriptorSchema) as z.ZodType<NonNullable<RunDetail["resolvedHooks"]>>
  ).optional(),
  hookState: z.record(z.string(), z.unknown()).optional(),
  hookAudits: z.array(hookAuditRecordSchema).optional(),
  dependencies: z.array(runDependencyDetailSchema),
  dependents: z.array(runDependentDetailSchema),
  schedule: runScheduleSchema.nullable(),
  scheduleState: runScheduleStateSchema,
  tasks: z.array(runTaskSummarySchema),
  activeTask: runActiveTaskSchema.nullable(),
  message: z.string().nullable(),
  pendingPrompt: z.string().nullable(),
  callerInstructions: z.string().nullable(),
  lockedFields: z.array(z.enum(LOCKABLE_FIELDS)),
  runtimeVars: z.record(z.string(), z.unknown()),
  execution: runExecutionSchema,
  executionEnvironment: runExecutionEnvironmentSchema,
  capabilities: runCapabilitiesSchema,
});

export const runArchiveResultSchema: z.ZodType<RunArchiveResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  status: runStatusSchema,
  archivedAt: z.string().nullable(),
  changed: z.boolean(),
});

export const runNameResultSchema: z.ZodType<RunNameResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  name: z.string().nullable(),
  changed: z.boolean(),
});

export const runNoteResultSchema: z.ZodType<RunNoteResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  note: z.string().nullable(),
  changed: z.boolean(),
});

export const runPinnedResultSchema: z.ZodType<RunPinnedResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  pinned: z.boolean(),
  changed: z.boolean(),
});

export const runBackendSessionResultSchema: z.ZodType<RunBackendSessionResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  backendSessionId: z.string().nullable(),
  changed: z.boolean(),
});

export const runDependenciesResultSchema: z.ZodType<RunDependenciesResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  dependencies: z.array(runDependencyRefSchema),
  changed: z.boolean(),
});

export const runGroupResultSchema: z.ZodType<RunGroupResult> = z.object({
  runId: z.string(),
  updatedAt: z.string(),
  runGroupId: z.string(),
  previousRunGroupId: z.string(),
  changed: z.boolean(),
});

export const runDeleteResultSchema: z.ZodType<RunDeleteResult> = z.object({
  runId: z.string(),
});

export const queueResumeMessageResultSchema: z.ZodType<QueueResumeMessageResult> = z.object({
  run: runDetailSchema,
  queuedResumeMessage: queuedResumeMessageSchema,
});

export const removeQueuedResumeMessageResultSchema: z.ZodType<RemoveQueuedResumeMessageResult> =
  z.object({
    run: runDetailSchema,
    removedMessageId: z.string(),
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
  attemptNumber: z.number().int().positive(),
  sessionIndex: z.number().int().nonnegative(),
  attemptIndexInSession: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  prompt: z.string(),
  transcript: z.string(),
  notices: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  live: z.boolean(),
  provenance: z.union([
    // On-disk schema discriminator intentionally preserved across the Agent Runner rename.
    z.object({ kind: z.literal("task_runner") }),
    z.object({
      kind: z.literal("backend_session"),
      mode: z.union([z.literal("bootstrap"), z.literal("sync")]),
    }),
  ]),
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

export const runAuditEventSchema: z.ZodType<RunAuditEvent> = z.object({
  type: z.string() as z.ZodType<RunAuditEvent["type"]>,
  recordedAt: z.string(),
  source: z.enum(["system", "cli", "daemon", "task_command"]),
  hostMode: z.enum(["embedded", "daemon"]),
  controllerInstanceId: z.string().optional(),
  sessionIndex: z.number().int().nonnegative().optional(),
  attemptNumber: z.number().int().nonnegative().optional(),
  fields: z.record(z.string(), z.unknown()),
});

export const runAuditEnvelopeSchema: z.ZodType<RunAuditEnvelope> = z.object({
  runId: z.string(),
  cursor: z.number().int().positive(),
  event: runAuditEventSchema,
});

export const runAuditHistorySchema: z.ZodType<RunAuditHistory> = z.object({
  runId: z.string(),
  events: z.array(runAuditEnvelopeSchema),
  lastCursor: z.number().int().nonnegative(),
});
