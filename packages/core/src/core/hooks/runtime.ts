import { basename } from "node:path";
import type { TaskState, TaskStatus } from "../../assignment/model.js";
import type { RunAttachment } from "../../contracts/attachments.js";
import { shortId } from "../../util/short-id.js";
import type { LockableField } from "../config/schema.js";
import {
  getAttachment,
  removeAttachmentFiles,
  stageAttachmentFromFile,
} from "../run/attachments.js";
import {
  type RunManifest,
  type RuntimeVarSourceRecord,
  cloneRuntimeVarSources,
} from "../run/manifest.js";
import {
  type RunEventWriteContext,
  appendRunHookRecordedEvent,
  systemRunEventContext,
} from "../run/run-events.js";
import { loadHookModule } from "./loader.js";
import type {
  AttemptHookContext,
  AttemptHookWhen,
  HookAuditRecord,
  HookModule,
  HookMutations,
  HookResult,
  PrepareHookContext,
  ResolvedHookDescriptor,
  TaskTransitionHookContext,
  TaskTransitionHookWhen,
  TaskTransitionResult,
  TaskTransitionSource,
} from "./types.js";

export class HookRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookRuntimeError";
  }
}

interface AttemptResultSnapshot {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  transcript: string | null;
  rawStdout: string;
  rawStderr: string;
  sessionId: string | null;
  aborted: boolean;
}

interface HookExecutionState {
  manifest: RunManifest;
  tasks: Map<string, TaskState>;
  initialPrompt: string;
  attemptPrompt: string;
  eventContext: RunEventWriteContext;
}

interface HookAuditContext {
  sessionIndex: number | null;
  attemptNumber: number | null;
  taskId: string | null;
}

export interface AttemptPhaseResult {
  status: "continue" | "reinvoke" | "block";
  followUpPrompt?: string;
  reason?: string;
}

export interface TaskTransitionOutcome {
  accepted: boolean;
  reason: string | null;
}

function tasksSnapshot(tasks: Map<string, TaskState>) {
  const items = Array.from(tasks.values()).map((task) => ({ ...task }));
  return {
    items,
    completed: items.filter((task) => task.status === "completed").length,
    total: items.length,
  };
}

function cloneTasks(tasks: Map<string, TaskState>): Map<string, TaskState> {
  return new Map(Array.from(tasks.entries()).map(([id, task]) => [id, { ...task }]));
}

function normalizeNote(note: string | null): string | null {
  const trimmed = note?.trim() ?? "";
  return trimmed.length === 0 ? null : note;
}

function buildAuditRecord(
  descriptor: ResolvedHookDescriptor,
  outcome: string,
  summary: string | null,
  context: HookAuditContext,
  startedAt: string,
  endedAt: string,
): HookAuditRecord {
  return {
    phase: descriptor.phase,
    hookId: descriptor.hookId,
    startedAt,
    endedAt,
    outcome,
    sessionIndex: context.sessionIndex,
    attemptNumber: context.attemptNumber,
    taskId: context.taskId,
    summary,
  };
}

function recordHookAudit(
  state: HookExecutionState,
  descriptor: ResolvedHookDescriptor,
  outcome: string,
  summary: string | null,
  context: HookAuditContext,
  startedAt: string,
  endedAt: string,
): void {
  const audit = buildAuditRecord(descriptor, outcome, summary, context, startedAt, endedAt);
  state.manifest.hookAudits.push(audit);
  appendRunHookRecordedEvent({
    manifest: state.manifest,
    context: state.eventContext,
    phase: audit.phase,
    hookId: audit.hookId,
    outcome: audit.outcome,
    startedAt: audit.startedAt,
    endedAt: audit.endedAt,
    sessionIndex: audit.sessionIndex,
    attemptNumber: audit.attemptNumber,
    taskId: audit.taskId,
    summary: audit.summary,
  });
}

async function applyAttachmentMutations(
  manifest: RunManifest,
  attachments: NonNullable<HookMutations["attachments"]>,
): Promise<void> {
  for (const attachmentId of attachments.remove ?? []) {
    removeAttachmentFiles(manifest, attachmentId);
    manifest.attachments = manifest.attachments.filter(
      (attachment) => attachment.id !== attachmentId,
    );
  }

  for (const replacement of attachments.replace ?? []) {
    const current = getAttachment(manifest, replacement.attachmentId);
    const staged = await stageAttachmentFromFile(
      {
        ...manifest,
        attachments: manifest.attachments.filter(
          (attachment) => attachment.id !== replacement.attachmentId,
        ),
      },
      {
        id: current.id,
        name: replacement.name ?? current.name,
        sourcePath: replacement.sourcePath,
        mimeType: replacement.mimeType,
      },
    );
    removeAttachmentFiles(manifest, replacement.attachmentId);
    manifest.attachments = manifest.attachments.map((attachment) =>
      attachment.id === replacement.attachmentId ? staged : attachment,
    );
  }

  for (const addition of attachments.add ?? []) {
    const attachment = await stageAttachmentFromFile(manifest, {
      id: `att-${shortId()}`,
      name: addition.name ?? basename(addition.sourcePath),
      sourcePath: addition.sourcePath,
      mimeType: addition.mimeType,
    });
    manifest.attachments = [...manifest.attachments, attachment];
  }
}

function applyTaskPatches(
  tasks: Map<string, TaskState>,
  patches: NonNullable<HookMutations["patchTasks"]>,
) {
  for (const patch of patches) {
    const task = tasks.get(patch.taskId);
    if (!task) {
      throw new HookRuntimeError(`hook patchTasks references unknown task "${patch.taskId}"`);
    }
    if (patch.notesReplace !== undefined && patch.notesAppend !== undefined) {
      throw new HookRuntimeError(
        `hook patchTasks for task "${patch.taskId}" cannot set both notesReplace and notesAppend`,
      );
    }
    if (patch.status !== undefined) {
      task.status = patch.status;
    }
    if (patch.notesReplace !== undefined) {
      task.notes = patch.notesReplace;
    }
    if (patch.notesAppend !== undefined) {
      task.notes =
        task.notes.length === 0 ? patch.notesAppend : `${task.notes}\n${patch.notesAppend}`;
    }
  }
}

async function applyMutations(
  state: HookExecutionState,
  mutate: HookMutations | undefined,
  options: {
    allowVars: boolean;
  },
): Promise<void> {
  if (!mutate) {
    return;
  }

  if (mutate.run) {
    const run = mutate.run;
    if (run.cwd !== undefined) {
      state.manifest.cwd = run.cwd;
    }
    if (run.backend !== undefined) {
      state.manifest.backend = run.backend;
    }
    if (run.model !== undefined) {
      state.manifest.model = run.model;
    }
    if (run.effort !== undefined) {
      state.manifest.effort = run.effort;
    }
    if (run.timeoutSec !== undefined) {
      state.manifest.timeoutSec = run.timeoutSec;
    }
    if (run.unrestricted !== undefined) {
      state.manifest.unrestricted = run.unrestricted;
    }
    if (run.lockedFields !== undefined) {
      state.manifest.lockedFields = [...run.lockedFields];
    }
    if (run.initialPrompt !== undefined) {
      state.initialPrompt = run.initialPrompt;
    }
    if (run.attemptPrompt !== undefined) {
      state.attemptPrompt = run.attemptPrompt;
    }
  }

  if (mutate.vars) {
    if (!options.allowVars) {
      throw new HookRuntimeError("hook vars mutations are only allowed during prepare");
    }
    state.manifest.runtimeVars = {
      ...state.manifest.runtimeVars,
      ...mutate.vars,
    };
    state.manifest.runtimeVarSources = {
      ...state.manifest.runtimeVarSources,
      ...Object.fromEntries(
        Object.keys(mutate.vars).map((key) => [
          key,
          { source: "hook" } satisfies RuntimeVarSourceRecord,
        ]),
      ),
    };
  }

  if (mutate.state) {
    state.manifest.hookState = {
      ...state.manifest.hookState,
      ...mutate.state,
    };
  }

  if (mutate.note !== undefined) {
    state.manifest.note = normalizeNote(mutate.note);
  }

  if (mutate.pinned !== undefined) {
    state.manifest.pinned = mutate.pinned;
  }

  if (mutate.patchTasks) {
    applyTaskPatches(state.tasks, mutate.patchTasks);
  }

  if (mutate.attachments) {
    await applyAttachmentMutations(state.manifest, mutate.attachments);
  }
}

function matchesTaskTransitionWhen(
  descriptor: ResolvedHookDescriptor,
  options: {
    source: TaskTransitionSource;
    taskId: string;
    from: TaskTransitionHookContext["transition"]["from"];
    to: TaskTransitionHookContext["transition"]["to"];
  },
): boolean {
  if (descriptor.taskScopeId !== null && descriptor.taskScopeId !== options.taskId) {
    return false;
  }

  const when = descriptor.when;
  if (!when) {
    return true;
  }
  const transitionWhen = when as TaskTransitionHookWhen;
  if (transitionWhen.taskId !== undefined && transitionWhen.taskId !== options.taskId) {
    return false;
  }
  if (transitionWhen.taskIds !== undefined && !transitionWhen.taskIds.includes(options.taskId)) {
    return false;
  }
  if (
    transitionWhen.fromStatus !== undefined &&
    (options.from === null || !transitionWhen.fromStatus.includes(options.from.status))
  ) {
    return false;
  }
  if (transitionWhen.source !== undefined && !transitionWhen.source.includes(options.source)) {
    return false;
  }
  const toStatus = transitionWhen.toStatus;
  if (Array.isArray(toStatus)) {
    return toStatus.includes(options.to.status);
  }
  return true;
}

function matchesAttemptWhen(
  descriptor: ResolvedHookDescriptor,
  sessionIndex: number,
  attemptIndexInSession: number,
): boolean {
  const when = descriptor.when;
  if (!when) {
    return true;
  }
  const attemptWhen = when as AttemptHookWhen;

  if (attemptWhen.sessionIndex !== undefined) {
    const configured = attemptWhen.sessionIndex;
    if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) {
      if (configured !== sessionIndex) {
        return false;
      }
    } else if (
      Array.isArray(configured) &&
      configured.every(
        (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
      )
    ) {
      if (!configured.includes(sessionIndex)) {
        return false;
      }
    } else {
      throw new HookRuntimeError(
        `hook ${descriptor.hookId} when.sessionIndex must be a non-negative integer or array of non-negative integers`,
      );
    }
  }

  if (attemptWhen.attemptIndexInSession !== undefined) {
    const configured = attemptWhen.attemptIndexInSession;
    if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) {
      if (configured !== attemptIndexInSession) {
        return false;
      }
    } else if (
      Array.isArray(configured) &&
      configured.every(
        (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
      )
    ) {
      if (!configured.includes(attemptIndexInSession)) {
        return false;
      }
    } else {
      throw new HookRuntimeError(
        `hook ${descriptor.hookId} when.attemptIndexInSession must be a non-negative integer or array of non-negative integers`,
      );
    }
  }

  return true;
}

async function invokeHook(
  descriptor: ResolvedHookDescriptor,
  hook: HookModule,
  ctx: PrepareHookContext | AttemptHookContext | TaskTransitionHookContext,
): Promise<HookResult | TaskTransitionResult | null> {
  switch (descriptor.phase) {
    case "prepare":
      return hook.prepare ? hook.prepare(ctx as PrepareHookContext) : null;
    case "beforeAttempt":
      return hook.beforeAttempt ? hook.beforeAttempt(ctx as AttemptHookContext) : null;
    case "afterAttempt":
      return hook.afterAttempt ? hook.afterAttempt(ctx as AttemptHookContext) : null;
    case "afterExit":
      return hook.afterExit ? hook.afterExit(ctx as AttemptHookContext) : null;
    case "taskTransition":
      return hook.taskTransition ? hook.taskTransition(ctx as TaskTransitionHookContext) : null;
  }
}

function attemptContext(
  descriptor: ResolvedHookDescriptor,
  state: HookExecutionState,
  sessionIndex: number,
  attemptIndexInSession: number,
  retriesRemaining: number,
  attemptResult?: AttemptResultSnapshot,
): AttemptHookContext {
  return {
    schemaVersion: 1,
    phase: descriptor.phase as AttemptHookContext["phase"],
    assignment: {
      name: state.manifest.assignment?.name ?? "",
      sourcePath: state.manifest.assignment?.sourcePath ?? null,
    },
    run: {
      runId: state.manifest.runId,
      repo: state.manifest.repo,
      status: state.manifest.status,
      backend: state.manifest.backend,
      model: state.manifest.model,
      effort: state.manifest.effort,
      cwd: state.manifest.cwd,
      workspaceDir: state.manifest.workspaceDir,
      name: state.manifest.name,
      note: state.manifest.note,
      pinned: state.manifest.pinned,
      backendSessionId: state.manifest.backendSessionId,
      totalAttemptCount: state.manifest.totalAttemptCount,
      maxAttemptsPerSession: state.manifest.maxAttemptsPerSession,
      totalSessionCount: state.manifest.totalSessionCount,
    },
    vars: { ...state.manifest.runtimeVars },
    state: { ...state.manifest.hookState },
    attachments: state.manifest.attachments.map((attachment) => ({ ...attachment })),
    tasks: tasksSnapshot(state.tasks),
    config: descriptor.config,
    attemptPrompt: state.attemptPrompt,
    attemptResult,
    retriesRemaining,
    sessionIndex,
    attemptIndexInSession,
  };
}

function prepareContext(
  descriptor: ResolvedHookDescriptor,
  state: HookExecutionState,
  defaultInitialPrompt: string,
  initialLockedFields: LockableField[],
): PrepareHookContext {
  return {
    ...attemptContext(descriptor, state, 0, 0, state.manifest.maxAttemptsPerSession - 1),
    phase: "prepare",
    defaultInitialPrompt,
    currentInitialPrompt: state.initialPrompt,
    initialLockedFields,
  };
}

function taskTransitionContext(
  descriptor: ResolvedHookDescriptor,
  state: HookExecutionState,
  transition: TaskTransitionHookContext["transition"],
): TaskTransitionHookContext {
  return {
    ...attemptContext(
      descriptor,
      state,
      state.manifest.totalSessionCount,
      0,
      state.manifest.maxAttemptsPerSession,
    ),
    phase: "taskTransition",
    transition,
  };
}

export async function runPrepareHooks(
  state: HookExecutionState,
  defaultInitialPrompt: string,
  initialLockedFields: LockableField[],
): Promise<void> {
  for (const descriptor of state.manifest.resolvedHooks.filter(
    (entry) => entry.phase === "prepare",
  )) {
    const startedAt = new Date().toISOString();
    try {
      const hook = await loadHookModule(descriptor);
      const result = await invokeHook(
        descriptor,
        hook,
        prepareContext(descriptor, state, defaultInitialPrompt, initialLockedFields),
      );
      const hookResult = result as HookResult | null;
      if (!hookResult) {
        recordHookAudit(
          state,
          descriptor,
          "skipped",
          null,
          { sessionIndex: null, attemptNumber: null, taskId: null },
          startedAt,
          new Date().toISOString(),
        );
        continue;
      }
      await applyMutations(state, hookResult.mutate, { allowVars: true });
      if (hookResult.action === "block") {
        throw new HookRuntimeError(hookResult.reason);
      }
      if (hookResult.action === "reinvoke") {
        state.initialPrompt = hookResult.followUpPrompt;
      }
      recordHookAudit(
        state,
        descriptor,
        hookResult.action,
        null,
        { sessionIndex: null, attemptNumber: null, taskId: null },
        startedAt,
        new Date().toISOString(),
      );
    } catch (error) {
      recordHookAudit(
        state,
        descriptor,
        "error",
        error instanceof Error ? error.message : String(error),
        { sessionIndex: null, attemptNumber: null, taskId: null },
        startedAt,
        new Date().toISOString(),
      );
      throw error;
    }
  }
}

export async function runAttemptHooks(
  phase: "beforeAttempt" | "afterAttempt" | "afterExit",
  state: HookExecutionState,
  options: {
    sessionIndex: number;
    attemptIndexInSession: number;
    attemptNumber: number | null;
    retriesRemaining: number;
    attemptResult?: AttemptResultSnapshot;
  },
): Promise<AttemptPhaseResult> {
  for (const descriptor of state.manifest.resolvedHooks.filter((entry) => entry.phase === phase)) {
    if (!matchesAttemptWhen(descriptor, options.sessionIndex, options.attemptIndexInSession)) {
      continue;
    }
    const startedAt = new Date().toISOString();
    try {
      const hook = await loadHookModule(descriptor);
      const result = (await invokeHook(
        descriptor,
        hook,
        attemptContext(
          descriptor,
          state,
          options.sessionIndex,
          options.attemptIndexInSession,
          options.retriesRemaining,
          options.attemptResult,
        ),
      )) as HookResult | null;
      if (!result) {
        recordHookAudit(
          state,
          descriptor,
          "skipped",
          null,
          {
            sessionIndex: options.sessionIndex,
            attemptNumber: options.attemptNumber,
            taskId: null,
          },
          startedAt,
          new Date().toISOString(),
        );
        continue;
      }
      await applyMutations(state, result.mutate, { allowVars: false });
      recordHookAudit(
        state,
        descriptor,
        result.action,
        result.action === "block" ? result.reason : null,
        { sessionIndex: options.sessionIndex, attemptNumber: options.attemptNumber, taskId: null },
        startedAt,
        new Date().toISOString(),
      );
      if (result.action === "continue") {
        continue;
      }
      if (result.action === "reinvoke") {
        return {
          status: "reinvoke",
          followUpPrompt: result.followUpPrompt,
        };
      }
      return {
        status: "block",
        reason: result.reason,
      };
    } catch (error) {
      recordHookAudit(
        state,
        descriptor,
        "error",
        error instanceof Error ? error.message : String(error),
        { sessionIndex: options.sessionIndex, attemptNumber: options.attemptNumber, taskId: null },
        startedAt,
        new Date().toISOString(),
      );
      throw error;
    }
  }

  return { status: "continue" };
}

export async function runTaskTransitionHooks(
  state: HookExecutionState,
  options: {
    source: TaskTransitionSource;
    taskId: string;
    from: TaskTransitionHookContext["transition"]["from"];
    to: TaskTransitionHookContext["transition"]["to"];
    changedFields: TaskTransitionHookContext["transition"]["changedFields"];
  },
): Promise<TaskTransitionOutcome> {
  for (const descriptor of state.manifest.resolvedHooks.filter(
    (entry) => entry.phase === "taskTransition",
  )) {
    if (
      !matchesTaskTransitionWhen(descriptor, {
        source: options.source,
        taskId: options.taskId,
        from: options.from,
        to: options.to,
      })
    ) {
      continue;
    }
    const startedAt = new Date().toISOString();
    try {
      const hook = await loadHookModule(descriptor);
      const result = (await invokeHook(
        descriptor,
        hook,
        taskTransitionContext(descriptor, state, {
          taskId: options.taskId,
          source: options.source,
          from: options.from,
          to: options.to,
          tentative: true,
          changedFields: options.changedFields,
        }),
      )) as TaskTransitionResult | null;
      if (!result) {
        recordHookAudit(
          state,
          descriptor,
          "skipped",
          null,
          { sessionIndex: null, attemptNumber: null, taskId: options.taskId },
          startedAt,
          new Date().toISOString(),
        );
        continue;
      }
      await applyMutations(state, result.mutate, { allowVars: false });
      recordHookAudit(
        state,
        descriptor,
        result.accept ? "accepted" : "rejected",
        result.accept ? null : result.reason,
        { sessionIndex: null, attemptNumber: null, taskId: options.taskId },
        startedAt,
        new Date().toISOString(),
      );
      if (!result.accept) {
        return {
          accepted: false,
          reason: result.reason,
        };
      }
    } catch (error) {
      recordHookAudit(
        state,
        descriptor,
        "error",
        error instanceof Error ? error.message : String(error),
        { sessionIndex: null, attemptNumber: null, taskId: options.taskId },
        startedAt,
        new Date().toISOString(),
      );
      throw error;
    }
  }

  return {
    accepted: true,
    reason: null,
  };
}

export function createHookExecutionState(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
  prompts: {
    initialPrompt: string;
    attemptPrompt?: string;
  },
  eventContext: RunEventWriteContext = systemRunEventContext(manifest.execution),
): HookExecutionState {
  return {
    manifest,
    tasks,
    initialPrompt: prompts.initialPrompt,
    attemptPrompt: prompts.attemptPrompt ?? prompts.initialPrompt,
    eventContext,
  };
}

export function cloneHookExecutionState(state: HookExecutionState): HookExecutionState {
  return {
    manifest: {
      ...state.manifest,
      lockedFields: [...state.manifest.lockedFields],
      dependencyRunIds: [...state.manifest.dependencyRunIds],
      runtimeVars: { ...state.manifest.runtimeVars },
      runtimeVarSources: cloneRuntimeVarSources(state.manifest.runtimeVarSources),
      hookState: { ...state.manifest.hookState },
      attachments: state.manifest.attachments.map((attachment) => ({ ...attachment })),
      finalTasks: { ...state.manifest.finalTasks },
      resolvedHooks: state.manifest.resolvedHooks.map((descriptor) => ({
        ...descriptor,
        source: { ...descriptor.source },
        when: descriptor.when ? { ...descriptor.when } : null,
      })),
      hookAudits: state.manifest.hookAudits.map((audit) => ({ ...audit })),
    },
    tasks: cloneTasks(state.tasks),
    initialPrompt: state.initialPrompt,
    attemptPrompt: state.attemptPrompt,
    eventContext: { ...state.eventContext },
  };
}
