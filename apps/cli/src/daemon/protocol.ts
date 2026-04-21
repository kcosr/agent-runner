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
  RunTimelineEnvelope,
  RunTimelineEvent,
  RunTimelineHistory,
} from "@task-runner/core/contracts/events.js";
import type {
  RunArchiveResult,
  RunBackendSessionResult,
  RunDependenciesResult,
  RunDetail,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunSummary,
  RunTaskSummary,
} from "@task-runner/core/contracts/runs.js";
import type { DefinitionListResult } from "@task-runner/core/core/commands/service.js";
import type { RunListFilter } from "@task-runner/core/core/commands/service.js";

export type RunEventChannel = "run_summary" | "run_detail" | "run_timeline" | "run_audit";

export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:4773/";
export const TASK_RUNNER_LISTEN_ENV = "TASK_RUNNER_LISTEN";
export const TASK_RUNNER_CONNECT_ENV = "TASK_RUNNER_CONNECT";
export const TASK_RUNNER_CONNECT_HOST_ENV = "TASK_RUNNER_CONNECT_HOST";
export const TASK_RUNNER_CONNECT_LOCAL_PORT_ENV = "TASK_RUNNER_CONNECT_LOCAL_PORT";
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

export interface DaemonInfo {
  daemonInstanceId: string;
  pid: number;
  listenUrl: string;
  version: string;
  startedAt: string;
}

export type RunsListParams = RunListFilter;

export interface RunTargetParams {
  target: string;
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

export interface RunDependencyParams extends RunTargetParams {
  dependencyRunId: string;
}

export interface TaskTargetParams extends RunTargetParams {
  taskId: string;
}

export interface TaskSetParams extends TaskTargetParams {
  status?: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
}

export interface TaskAppendNotesParams extends TaskTargetParams {
  text: string;
}

export interface TaskAddParams extends RunTargetParams {
  title: string;
  body?: string;
}

export interface DefinitionGetParams {
  target: string;
  cwd?: string;
}

export interface RunsStartParams {
  runId?: string;
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  callerCwd?: string;
  cliVars: Record<string, string>;
  backendSessionId?: string;
  overrides: RunCommandOverrides;
}

export interface RunsResumeParams {
  target: string;
  overrides: RunCommandOverrides;
}

export interface RunsTimelineHistoryParams extends RunTargetParams {}
export interface RunsAuditHistoryParams extends RunTargetParams {
  limit?: number;
}

export interface EventsSubscribeParams {
  channel: RunEventChannel;
  runId?: string;
}

export interface EventsSubscribeResult {
  subscriptionId: string;
}

export interface EventsUnsubscribeParams {
  subscriptionId: string;
}

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

export interface RunsListResult {
  runs: RunSummary[];
}

export interface RunResult {
  run: RunDetail;
}

export interface RunBriefResult {
  brief: string;
}

export interface RunsTimelineHistoryResult {
  history: RunTimelineHistory;
}

export interface RunsAuditHistoryResult {
  history: RunAuditHistory;
}

export interface TasksListResult {
  tasks: RunTaskSummary[];
}

export interface TaskResult {
  task: RunTaskSummary;
}

export interface AgentsListResult {
  agents: DefinitionListResult;
}

export interface AssignmentsListResult {
  assignments: DefinitionListResult;
}

export interface LaunchersListResult {
  launchers: DefinitionListResult;
}

export interface AgentResult {
  agent: DefinitionDetail;
}

export interface AssignmentResult {
  assignment: DefinitionDetail;
}

export interface LauncherResult {
  launcher: DefinitionDetail;
}

export interface RunArchiveRpcResult {
  result: RunArchiveResult;
}

export interface RunSetNameRpcResult {
  result: RunNameResult;
}

export interface RunSetNoteRpcResult {
  result: RunNoteResult;
}

export interface RunSetPinnedRpcResult {
  result: RunPinnedResult;
}

export interface RunBackendSessionRpcResult {
  result: RunBackendSessionResult;
}

export interface RunDependenciesRpcResult {
  result: RunDependenciesResult;
}

export interface RunsStartResult {
  runId: string;
}

export interface AttachmentsListResult {
  attachments: AttachmentListEntry[];
}

export interface AttachmentResult {
  attachment: RunAttachment;
}

export interface AttachmentRemoveHttpResult {
  result: RunAttachmentRemoveResult;
}

export type RunTimelineNotification = RunTimelineEnvelope & {
  subscriptionId: string;
};

export type RunAuditNotification = RunAuditEnvelope & {
  subscriptionId: string;
};
