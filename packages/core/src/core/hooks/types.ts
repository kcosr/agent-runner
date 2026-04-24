import type { TaskStatus } from "../../assignment/model.js";
import type { RunAttachment } from "../../contracts/attachments.js";
import type { HookPhase, LockableField } from "../config/schema.js";
import type { ManifestStatus, RunManifest } from "../run/manifest.js";

export interface HookSourceDescriptor {
  builtin?: string;
  name?: string;
  path?: string;
}

export type AttemptHookWhen = {
  sessionIndex?: number | number[];
  attemptIndexInSession?: number | number[];
};

export type TaskTransitionSource = "run-loop" | "task-set" | "task-append-notes" | "task-add";

export interface TaskTransitionHookWhen {
  taskId?: string;
  taskIds?: string[];
  fromStatus?: TaskStatus[];
  toStatus?: TaskStatus[];
  source?: TaskTransitionSource[];
}

export type HookWhen = AttemptHookWhen | TaskTransitionHookWhen | Record<string, unknown>;

export interface ResolvedHookDescriptor {
  hookId: string;
  phase: HookPhase;
  source: HookSourceDescriptor;
  resolvedPath: string | null;
  taskScopeId: string | null;
  when: HookWhen | null;
  config: unknown;
}

export interface HookAuditRecord {
  phase: HookPhase;
  hookId: string;
  startedAt: string;
  endedAt: string;
  outcome: string;
  sessionIndex: number | null;
  attemptNumber: number | null;
  taskId: string | null;
  summary: string | null;
}

export interface HookTaskPatch {
  taskId: string;
  status?: TaskStatus;
  notesReplace?: string;
  notesAppend?: string;
}

export interface HookAttachmentAdd {
  sourcePath: string;
  name?: string;
  mimeType?: string;
}

export interface HookAttachmentReplace extends HookAttachmentAdd {
  attachmentId: string;
}

export interface HookMutations {
  run?: {
    cwd?: string;
    backend?: RunManifest["backend"];
    model?: string | null;
    effort?: RunManifest["effort"];
    timeoutSec?: number;
    unrestricted?: boolean;
    lockedFields?: LockableField[];
    initialPrompt?: string;
    attemptPrompt?: string;
  };
  vars?: Record<string, unknown>;
  state?: Record<string, unknown>;
  note?: string | null;
  pinned?: boolean;
  patchTasks?: HookTaskPatch[];
  attachments?: {
    add?: HookAttachmentAdd[];
    remove?: string[];
    replace?: HookAttachmentReplace[];
  };
}

export type HookResult =
  | { action: "continue"; mutate?: HookMutations }
  | { action: "reinvoke"; followUpPrompt: string; mutate?: HookMutations }
  | { action: "block"; reason: string; mutate?: HookMutations };

export type TaskTransitionResult =
  | { accept: true; mutate?: HookMutations }
  | { accept: false; reason: string; mutate?: HookMutations };

export interface HookContextAssignment {
  name: string;
  sourcePath: string | null;
  workspacePath: string | null;
}

export interface HookContextRun {
  runId: string;
  repo: string;
  status: ManifestStatus;
  backend: RunManifest["backend"];
  model: string | null;
  effort: RunManifest["effort"];
  cwd: string;
  workspaceDir: string;
  assignmentPath: string;
  name: string | null;
  note: string | null;
  pinned: boolean;
  backendSessionId: string | null;
  totalAttemptCount: number;
  maxAttemptsPerSession: number;
  totalSessionCount: number;
}

export interface HookContextTasks {
  items: Array<{
    id: string;
    title: string;
    body: string;
    status: TaskStatus;
    notes: string;
  }>;
  completed: number;
  total: number;
}

export interface HookContextBase {
  schemaVersion: 1;
  phase: HookPhase;
  assignment: HookContextAssignment;
  run: HookContextRun;
  vars: Record<string, unknown>;
  state: Record<string, unknown>;
  attachments: RunAttachment[];
  tasks: HookContextTasks;
  config: unknown;
}

export interface PrepareHookContext extends HookContextBase {
  phase: "prepare";
  defaultInitialPrompt: string;
  currentInitialPrompt: string;
  initialLockedFields: LockableField[];
}

export interface AttemptHookContext extends HookContextBase {
  phase: "beforeAttempt" | "afterAttempt" | "afterExit";
  attemptPrompt: string;
  attemptResult?: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    transcript: string | null;
    rawStdout: string;
    rawStderr: string;
    sessionId: string | null;
    aborted: boolean;
  };
  retriesRemaining: number;
  sessionIndex: number;
  attemptIndexInSession: number;
}

export interface TaskTransitionHookContext extends HookContextBase {
  phase: "taskTransition";
  transition: {
    taskId: string;
    source: TaskTransitionSource;
    from: {
      status: TaskStatus;
      notes: string;
    } | null;
    to: {
      status: TaskStatus;
      notes: string;
      title: string;
      body: string;
    };
    tentative: boolean;
    changedFields: Array<"status" | "notes" | "title" | "body">;
  };
}

export interface HookModule {
  name: string;
  prepare?: (ctx: PrepareHookContext) => Promise<HookResult> | HookResult;
  beforeAttempt?: (ctx: AttemptHookContext) => Promise<HookResult> | HookResult;
  afterAttempt?: (ctx: AttemptHookContext) => Promise<HookResult> | HookResult;
  afterExit?: (ctx: AttemptHookContext) => Promise<HookResult> | HookResult;
  taskTransition?: (
    ctx: TaskTransitionHookContext,
  ) => Promise<TaskTransitionResult> | TaskTransitionResult;
}

/**
 * Helper for authoring hook modules with strong type inference.
 *
 * Hook modules export `defineHook({ ... })` as their default value and
 * are then loaded by builtin/name/path hook resolution.
 */
export function defineHook<T extends HookModule>(hook: T): T {
  return hook;
}
