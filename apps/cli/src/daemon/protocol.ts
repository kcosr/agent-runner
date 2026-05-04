import type { DefinitionDetail, RunCommandOverrides } from "@task-runner/core/app/service.js";
import type { DefinitionEntry } from "@task-runner/core/config/loader.js";
import type {
  AttachmentListEntry,
  RunAttachment,
  RunAttachmentRemoveResult,
} from "@task-runner/core/contracts/attachments.js";
import type {
  RunAuditEnvelope,
  RunAuditHistory,
  RunTimelineEvent,
  RunTimelineHistory,
} from "@task-runner/core/contracts/events.js";
import type {
  RunInputSurfaceParams,
  RunInputSurfaceResult,
} from "@task-runner/core/contracts/run-input-surface.js";
import type {
  QueueResumeMessageResult,
  RemoveQueuedResumeMessageResult,
  RunArchiveResult,
  RunBackendSessionResult,
  RunDependenciesResult,
  RunDependencyRef,
  RunDetail,
  RunGroupResult,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunSummary,
  RunTaskSummary,
} from "@task-runner/core/contracts/runs.js";
import type { DefinitionListResult } from "@task-runner/core/core/commands/service.js";
import type { RunListFilter } from "@task-runner/core/core/commands/service.js";
import type { ScheduleInput } from "@task-runner/core/core/run/schedule.js";

type TaskDefinitionDetail = Extract<DefinitionDetail, { kind: "task" }>;
type RunEventChannel = "run_summary" | "run_detail" | "run_timeline" | "run_audit";

export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:4773/";
export const TASK_RUNNER_LISTEN_ENV = "TASK_RUNNER_LISTEN";
export const TASK_RUNNER_CONNECT_ENV = "TASK_RUNNER_CONNECT";
export const TASK_RUNNER_CONNECT_HOST_ENV = "TASK_RUNNER_CONNECT_HOST";
export const TASK_RUNNER_CONNECT_LOCAL_PORT_ENV = "TASK_RUNNER_CONNECT_LOCAL_PORT";
export const TASK_RUNNER_DAEMON_AUTH_ENABLED_ENV = "TASK_RUNNER_DAEMON_AUTH_ENABLED";
export const TASK_RUNNER_DAEMON_TOKEN_ENV = "TASK_RUNNER_DAEMON_TOKEN";
export const RPC_ERROR_COMMAND = -32003;
export const RPC_ERROR_RUNTIME = -32004;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface StreamDataNotification {
  jsonrpc: "2.0";
  method: "stream.data";
  params: {
    streamId: string;
    seq: number;
    data: string;
  };
}

interface StreamEndNotification {
  jsonrpc: "2.0";
  method: "stream.end";
  params: {
    streamId: string;
    seq: number;
  };
}

interface StreamErrorNotification {
  jsonrpc: "2.0";
  method: "stream.error";
  params: {
    streamId: string;
    message: string;
    code?: string;
  };
}

interface StreamCancelNotification {
  jsonrpc: "2.0";
  method: "stream.cancel";
  params: {
    streamId: string;
    reason?: string;
  };
}

interface StreamWindowNotification {
  jsonrpc: "2.0";
  method: "stream.window";
  params: {
    streamId: string;
    bytes: number;
  };
}

export type StreamNotification =
  | StreamDataNotification
  | StreamEndNotification
  | StreamErrorNotification
  | StreamCancelNotification
  | StreamWindowNotification;

export interface DaemonInfo {
  daemonInstanceId: string;
  pid: number;
  listenUrl: string;
  version: string;
  startedAt: string;
}

export type RunsListParams = RunListFilter;

interface RunTargetParams {
  target: string;
}

export interface RunReadyParams extends RunTargetParams {
  schedule?: ScheduleInput;
}

export interface RunQueueResumeMessageParams extends RunTargetParams {
  message: string;
}

export interface RunRemoveQueuedResumeMessageParams extends RunTargetParams {
  messageId: string;
}

export interface RunsReconfigureParams extends RunTargetParams {
  vars?: Record<string, string>;
  message?: string;
}

export interface RunScheduleParams extends RunTargetParams {
  schedule: ScheduleInput;
}

export interface RunSetNameParams extends RunTargetParams {
  name: string | null;
}

export interface RunSetNoteParams extends RunTargetParams {
  note: string | null;
}

export interface RunSetPinnedParams extends RunTargetParams {
  pinned: boolean;
}

export interface RunSetBackendSessionParams extends RunTargetParams {
  backendSessionId: string;
}

interface RunDependencyParams extends RunTargetParams {
  dependency: RunDependencyRef;
}

export interface RunSetGroupParams extends RunTargetParams {
  runGroupId: string;
}

interface TaskTargetParams extends RunTargetParams {
  taskId: string;
}

interface TaskSetParams extends TaskTargetParams {
  status?: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
}

interface TaskAppendNotesParams extends TaskTargetParams {
  text: string;
}

interface TaskAddParams extends RunTargetParams {
  title: string;
  body?: string;
}

export interface AttachmentsListParams {
  runId: string;
  scope?: "run" | "group";
}

export interface AttachmentsRemoveParams {
  runId: string;
  attachmentId: string;
}

export interface AttachmentsUploadOpenParams {
  runId: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export interface AttachmentsUploadFinishParams {
  streamId: string;
}

export interface AttachmentsDownloadParams {
  runId: string;
  attachmentId: string;
}

export interface DefinitionGetParams {
  target: string;
  cwd?: string;
}

export type { RunInputSurfaceParams };

interface RunsStartBaseParams {
  runId?: string;
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  callerCwd?: string;
  parentRunId?: string;
  runGroupId?: string;
  backendSessionId?: string;
  overrides: RunCommandOverrides;
}

export interface CliRunsStartParams extends RunsStartBaseParams {
  cliVars: Record<string, string>;
}

export interface WebRunsStartParams extends RunsStartBaseParams {
  webVars: Record<string, string>;
}

export interface RunsResumeParams {
  target: string;
  parentRunId?: string;
  overrides: RunCommandOverrides;
}

export interface EventsSubscribeParams {
  channel: RunEventChannel;
  runId?: string;
}

/** @protocol */
export interface EventsSubscribeResult {
  subscriptionId: string;
}

/** @protocol */
export interface EventsUnsubscribeParams {
  subscriptionId: string;
}

/** @protocol */
export interface EventsUnsubscribeResult {
  unsubscribed: true;
}

export type RunSummaryNotificationParams =
  | {
      subscriptionId: string;
      type: "summary_upsert";
      summary: RunSummary;
    }
  | {
      subscriptionId: string;
      type: "summary_removed";
      runId: string;
    };

export interface RunDetailNotificationParams {
  subscriptionId: string;
  runId: string;
  detail: RunDetail;
}

export interface RunTimelineNotificationParams {
  subscriptionId: string;
  runId: string;
  cursor: number;
  event: RunTimelineEvent;
}

export interface RunAuditNotificationParams {
  subscriptionId: string;
  runId: string;
  cursor: number;
  event: RunAuditEnvelope["event"];
}

/** @protocol */
export interface RunsListResult {
  runs: RunSummary[];
}

/** @protocol */
export interface RunResult {
  run: RunDetail;
}

/** @protocol */
export interface RunBriefResult {
  brief: string;
}

/** @protocol */
export interface RunsTimelineHistoryResult {
  history: RunTimelineHistory;
}

/** @protocol */
export interface RunsAuditHistoryResult {
  history: RunAuditHistory;
}

/** @protocol */
export interface TasksListResult {
  tasks: RunTaskSummary[];
}

/** @protocol */
export interface TaskResult {
  task: RunTaskSummary;
}

export interface AttachmentsListResult {
  attachments: AttachmentListEntry[];
}

export interface AttachmentsRemoveResult {
  result: RunAttachmentRemoveResult;
}

export interface AttachmentsUploadOpenResult {
  streamId: string;
  maxBytes: number;
  maxChunkBytes: number;
}

export interface AttachmentsUploadFinishResult {
  attachment: RunAttachment;
}

export interface AttachmentsDownloadResult {
  attachment: RunAttachment;
  streamId: string;
  maxChunkBytes: number;
}

/** @protocol */
export interface AgentsListResult {
  agents: DefinitionListResult;
}

/** @protocol */
export interface AssignmentsListResult {
  assignments: DefinitionListResult;
}

/** @protocol */
export interface LaunchersListResult {
  launchers: DefinitionListResult;
}

/** @protocol */
export interface TaskDefinitionsListResult {
  taskDefinitions: DefinitionListResult;
}

/** @protocol */
export interface AgentResult {
  agent: DefinitionDetail;
}

/** @protocol */
export interface AssignmentResult {
  assignment: DefinitionDetail;
}

/** @protocol */
export interface LauncherResult {
  launcher: DefinitionDetail;
}

/** @protocol */
export interface TaskDefinitionResult {
  taskDefinition: TaskDefinitionDetail;
}

/** @protocol */
export type { RunInputSurfaceResult };

/** @protocol */
export interface RunArchiveRpcResult {
  result: RunArchiveResult;
}

/** @protocol */
export interface RunSetNameRpcResult {
  result: RunNameResult;
}

/** @protocol */
export interface RunSetNoteRpcResult {
  result: RunNoteResult;
}

/** @protocol */
export interface RunSetPinnedRpcResult {
  result: RunPinnedResult;
}

/** @protocol */
export interface RunBackendSessionRpcResult {
  result: RunBackendSessionResult;
}

/** @protocol */
export interface RunDependenciesRpcResult {
  result: RunDependenciesResult;
}

/** @protocol */
export interface RunQueueResumeMessageRpcResult extends QueueResumeMessageResult {}

/** @protocol */
export interface RunRemoveQueuedResumeMessageRpcResult extends RemoveQueuedResumeMessageResult {}

/** @protocol */
export interface RunGroupRpcResult {
  result: RunGroupResult;
}

/** @protocol */
export interface RunsStartResult {
  runId: string;
}

/** @protocol */
export interface AttachmentResult {
  attachment: RunAttachment;
}

/** @protocol */
export interface AttachmentRemoveHttpResult {
  result: RunAttachmentRemoveResult;
}
