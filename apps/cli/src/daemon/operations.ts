import type {
  addDependency,
  addRunAttachmentFromStream,
  appendNotes,
  archive,
  clearBackendSession,
  clearDependencies,
  createTask,
  deleteArchivedRun,
  getAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunAuditTimelineHistory,
  getRunBrief,
  getRunList,
  getRunSummary,
  getRunTimelineHistory,
  getTask,
  getTaskList,
  initRun,
  readyRun,
  removeDependency,
  removeRunAttachment,
  renameRun,
  reset,
  resumeRun,
  startRun,
  unarchive,
  updateRunBackendSession,
  updateRunNote,
  updateRunPinned,
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
  getRunAuditTimelineHistory: typeof getRunAuditTimelineHistory;
  getRunBrief: typeof getRunBrief;
  getRunList: typeof getRunList;
  getRunSummary: typeof getRunSummary;
  getRunTimelineHistory: typeof getRunTimelineHistory;
  getTask: typeof getTask;
  getTaskList: typeof getTaskList;
  getDefinition: typeof getDefinition;
  getDefinitionList: typeof getDefinitionList;
  getAttachment: typeof getAttachment;
  getAttachmentList: typeof getAttachmentList;
  archive: typeof archive;
  unarchive: typeof unarchive;
  deleteArchivedRun: typeof deleteArchivedRun;
  renameRun: typeof renameRun;
  updateRunNote: typeof updateRunNote;
  updateRunPinned: typeof updateRunPinned;
  updateRunBackendSession: typeof updateRunBackendSession;
  clearBackendSession: typeof clearBackendSession;
  addDependency: typeof addDependency;
  removeDependency: typeof removeDependency;
  clearDependencies: typeof clearDependencies;
  addRunAttachmentFromStream: typeof addRunAttachmentFromStream;
  removeRunAttachment: typeof removeRunAttachment;
  reset: typeof reset;
  updateTask: typeof updateTask;
  appendNotes: typeof appendNotes;
  createTask: typeof createTask;
  initRun: typeof initRun;
  readyRun: typeof readyRun;
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
        runs: ctx.getRunList(params),
      };
    },
    getRun(target: string) {
      return { run: ctx.getRun(target) };
    },
    getRunAuditTimelineHistory(target: string) {
      return { history: ctx.getRunAuditTimelineHistory(target) };
    },
    getRunTimelineHistory(target: string) {
      return { history: ctx.getRunTimelineHistory(target) };
    },
    getRunBrief(target: string) {
      return { brief: ctx.getRunBrief(target) };
    },
    initRun(request: RunsStartParams) {
      return ctx.initRun(request).then((run) => ({ run }));
    },
    readyRun(target: string) {
      return { run: ctx.readyRun(target) };
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
    deleteRun(target: string) {
      return { result: ctx.deleteArchivedRun(target) };
    },
    async setRunName(target: string, input: Parameters<typeof renameRun>[1]) {
      return { result: await ctx.renameRun(target, input) };
    },
    setRunNote(target: string, input: Parameters<typeof updateRunNote>[1]) {
      return { result: ctx.updateRunNote(target, input) };
    },
    setRunPinned(target: string, input: Parameters<typeof updateRunPinned>[1]) {
      return { result: ctx.updateRunPinned(target, input) };
    },
    setRunBackendSession(target: string, input: Parameters<typeof updateRunBackendSession>[1]) {
      return { result: ctx.updateRunBackendSession(target, input) };
    },
    clearBackendSession(target: string) {
      return { result: ctx.clearBackendSession(target) };
    },
    addDependency(target: string, dependencyRunId: string) {
      return { result: ctx.addDependency(target, dependencyRunId) };
    },
    removeDependency(target: string, dependencyRunId: string) {
      return { result: ctx.removeDependency(target, dependencyRunId) };
    },
    clearDependencies(target: string) {
      return { result: ctx.clearDependencies(target) };
    },
    listAttachments(target: string, options?: { cwdScope?: boolean }) {
      return { attachments: ctx.getAttachmentList(target, options) };
    },
    async addAttachment(target: string, input: Parameters<typeof addRunAttachmentFromStream>[1]) {
      return { attachment: await ctx.addRunAttachmentFromStream(target, input) };
    },
    getAttachment(target: string, attachmentId: string) {
      return ctx.getAttachment(target, attachmentId);
    },
    removeAttachment(target: string, attachmentId: string) {
      return { result: ctx.removeRunAttachment(target, attachmentId) };
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
    async updateTask(target: string, taskId: string, updates: Parameters<typeof updateTask>[2]) {
      return { task: await ctx.updateTask(target, taskId, updates) };
    },
    async appendTaskNotes(target: string, taskId: string, text: string) {
      return { task: await ctx.appendNotes(target, taskId, text) };
    },
    async createTask(target: string, task: Parameters<typeof createTask>[1]) {
      return { task: await ctx.createTask(target, task) };
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
    listLaunchers() {
      return { launchers: ctx.getDefinitionList("launcher") };
    },
    getLauncher(params: DefinitionGetParams) {
      return {
        launcher: ctx.getDefinition("launcher", params.target, params.cwd),
      };
    },
  };
}

export type DaemonOperations = ReturnType<typeof createDaemonOperations>;
