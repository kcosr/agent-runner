import type {
  appendNotes,
  archive,
  createTask,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunList,
  getTask,
  getTaskList,
  initRun,
  reset,
  resumeRun,
  startRun,
  unarchive,
  updateTask,
} from "@task-runner/core/app/service.js";
import type {
  DaemonInfo,
  DefinitionGetParams,
  RunsListParams,
  RunsResumeParams,
  RunsStartParams,
} from "./protocol.js";

export interface DaemonHandlers {
  getRun: typeof getRun;
  getRunList: typeof getRunList;
  getTask: typeof getTask;
  getTaskList: typeof getTaskList;
  getDefinition: typeof getDefinition;
  getDefinitionList: typeof getDefinitionList;
  archive: typeof archive;
  unarchive: typeof unarchive;
  reset: typeof reset;
  updateTask: typeof updateTask;
  appendNotes: typeof appendNotes;
  createTask: typeof createTask;
  initRun: typeof initRun;
  startRun: typeof startRun;
  resumeRun: typeof resumeRun;
}

export interface DaemonOperationContext extends DaemonHandlers {
  daemonInfo: DaemonInfo;
  startManagedRun(request: RunsStartParams): Promise<{ runId: string }>;
  resumeManagedRun(request: RunsResumeParams): Promise<{ runId: string }>;
  abortRun(target: string): { runId: string; accepted: true };
}

export function createDaemonOperations(ctx: DaemonOperationContext) {
  return {
    readDaemonInfo() {
      return { daemon: ctx.daemonInfo };
    },
    listRuns(params: RunsListParams = {}) {
      return {
        runs: ctx.getRunList({
          includeArchived: params.includeArchived === true,
        }),
      };
    },
    getRun(target: string) {
      return { run: ctx.getRun(target) };
    },
    initRun(request: RunsStartParams) {
      return ctx.initRun(request).then((run) => ({ run }));
    },
    startRun(request: RunsStartParams) {
      return ctx.startManagedRun(request);
    },
    resumeRun(request: RunsResumeParams) {
      return ctx.resumeManagedRun(request);
    },
    archiveRun(target: string) {
      return { result: ctx.archive(target) };
    },
    unarchiveRun(target: string) {
      return { result: ctx.unarchive(target) };
    },
    abortRun(target: string) {
      return ctx.abortRun(target);
    },
    resetRun(target: string) {
      return { run: ctx.reset(target) };
    },
    listTasks(target: string) {
      return { tasks: ctx.getTaskList(target) };
    },
    getTask(target: string, taskId: string) {
      return { task: ctx.getTask(target, taskId) };
    },
    updateTask(target: string, taskId: string, updates: Parameters<typeof updateTask>[2]) {
      return { task: ctx.updateTask(target, taskId, updates) };
    },
    appendTaskNotes(target: string, taskId: string, text: string) {
      return { task: ctx.appendNotes(target, taskId, text) };
    },
    createTask(target: string, task: Parameters<typeof createTask>[1]) {
      return { task: ctx.createTask(target, task) };
    },
    listAgents() {
      return { agents: ctx.getDefinitionList("agent") };
    },
    getAgent(params: DefinitionGetParams) {
      return {
        agent: ctx.getDefinition("agent", params.target, params.cwd),
      };
    },
    listAssignments() {
      return { assignments: ctx.getDefinitionList("assignment") };
    },
    getAssignment(params: DefinitionGetParams) {
      return {
        assignment: ctx.getDefinition("assignment", params.target, params.cwd),
      };
    },
  };
}

export type DaemonOperations = ReturnType<typeof createDaemonOperations>;
