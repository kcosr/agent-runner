import type { DefinitionDetail, RunCommandOverrides } from "@task-runner/core/app/service.js";
import type { DefinitionEntry } from "@task-runner/core/config/loader.js";
import type {
  RunAttachment,
  RunAttachmentRemoveResult,
} from "@task-runner/core/contracts/attachments.js";
import type { RunTimelineEvent } from "@task-runner/core/contracts/events.js";
import type {
  RunArchiveResult,
  RunDependenciesResult,
  RunDetail,
  RunNameResult,
  RunSummary,
  RunTaskSummary,
} from "@task-runner/core/contracts/runs.js";

export type RunEventChannel = "run_summary" | "run_detail" | "run_timeline";

export const DEFAULT_DAEMON_URL = "ws://127.0.0.1:4773/";
export const TASK_RUNNER_LISTEN_ENV = "TASK_RUNNER_LISTEN";
export const TASK_RUNNER_CONNECT_ENV = "TASK_RUNNER_CONNECT";
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

export interface RunsListParams {
  includeArchived?: boolean;
}

export interface RunTargetParams {
  target: string;
}

export interface RunSetNameParams extends RunTargetParams {
  name: string | null;
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

export interface RunSummaryNotificationParams {
  subscriptionId: string;
  summary: RunSummary;
}

export interface RunDetailNotificationParams {
  subscriptionId: string;
  runId: string;
  detail: RunDetail;
}

export interface RunTimelineNotificationParams {
  subscriptionId: string;
  runId: string;
  event: RunTimelineEvent;
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

export interface TasksListResult {
  tasks: RunTaskSummary[];
}

export interface TaskResult {
  task: RunTaskSummary;
}

export interface AgentsListResult {
  agents: DefinitionEntry[];
}

export interface AssignmentsListResult {
  assignments: DefinitionEntry[];
}

export interface AgentResult {
  agent: DefinitionDetail;
}

export interface AssignmentResult {
  assignment: DefinitionDetail;
}

export interface RunArchiveRpcResult {
  result: RunArchiveResult;
}

export interface RunSetNameRpcResult {
  result: RunNameResult;
}

export interface RunDependenciesRpcResult {
  result: RunDependenciesResult;
}

export interface RunsStartResult {
  runId: string;
}

export interface AttachmentsListResult {
  attachments: RunAttachment[];
}

export interface AttachmentResult {
  attachment: RunAttachment;
}

export interface AttachmentRemoveHttpResult {
  result: RunAttachmentRemoveResult;
}
