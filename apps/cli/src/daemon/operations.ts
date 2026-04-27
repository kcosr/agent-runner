import type {
  addDependency,
  addRunAttachmentFromStream,
  appendNotes,
  archive,
  clearBackendSession,
  clearDependencies,
  clearGroup,
  clearRunSchedule,
  createTask,
  deleteArchivedRun,
  getAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunAuditHistory,
  getRunBrief,
  getRunInputSurface,
  getRunList,
  getRunSummary,
  getRunTimelineHistory,
  getTask,
  getTaskList,
  initRun,
  readyRun,
  reconfigureRun,
  removeDependency,
  removeRunAttachment,
  renameRun,
  reset,
  resumeRun,
  setGroup,
  setRunSchedule,
  setRunScheduleEnabled,
  startRun,
  unarchive,
  updateRunBackendSession,
  updateRunNote,
  updateRunPinned,
  updateTask,
} from "@task-runner/core/app/service.js";
import type {
  CliRunsStartParams,
  DaemonInfo,
  DefinitionGetParams,
  RunInputSurfaceParams,
  RunReadyParams,
  RunScheduleParams,
  RunSetGroupParams,
  RunsListParams,
  RunsReconfigureParams,
  RunsResumeParams,
  WebRunsStartParams,
} from "./protocol.js";

type InternalStartRunRequest = Parameters<DaemonHandlers["startRun"]>[0];

export interface DaemonHandlers {
  getRun: typeof getRun;
  getRunBrief: typeof getRunBrief;
  getRunList: typeof getRunList;
  getRunSummary: typeof getRunSummary;
  getRunAuditHistory: typeof getRunAuditHistory;
  getRunTimelineHistory: typeof getRunTimelineHistory;
  getTask: typeof getTask;
  getTaskList: typeof getTaskList;
  getDefinition: typeof getDefinition;
  getDefinitionList: typeof getDefinitionList;
  getRunInputSurface: typeof getRunInputSurface;
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
  setGroup: typeof setGroup;
  clearGroup: typeof clearGroup;
  addDependency: typeof addDependency;
  removeDependency: typeof removeDependency;
  clearDependencies: typeof clearDependencies;
  setRunSchedule: typeof setRunSchedule;
  clearRunSchedule: typeof clearRunSchedule;
  setRunScheduleEnabled: typeof setRunScheduleEnabled;
  addRunAttachmentFromStream: typeof addRunAttachmentFromStream;
  removeRunAttachment: typeof removeRunAttachment;
  reset: typeof reset;
  reconfigureRun: typeof reconfigureRun;
  updateTask: typeof updateTask;
  appendNotes: typeof appendNotes;
  createTask: typeof createTask;
  initRun: typeof initRun;
  readyRun: typeof readyRun;
  startRun: typeof startRun;
  resumeRun: typeof resumeRun;
}

interface DaemonOperationContext extends DaemonHandlers {
  daemonInfo: DaemonInfo;
  startManagedRun(request: InternalStartRunRequest): Promise<{ runId: string }>;
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
    getRunAuditHistory(target: string, options?: { limit?: number }) {
      return { history: ctx.getRunAuditHistory(target, options) };
    },
    getRunTimelineHistory(target: string) {
      return { history: ctx.getRunTimelineHistory(target) };
    },
    getRunBrief(target: string) {
      return { brief: ctx.getRunBrief(target) };
    },
    initCliRun(request: CliRunsStartParams) {
      return ctx
        .initRun({
          ...request,
          webVars: {},
        })
        .then((run) => ({ run }));
    },
    initWebRun(request: WebRunsStartParams) {
      return ctx
        .initRun({
          ...request,
          cliVars: {},
        })
        .then((run) => ({ run }));
    },
    readyRun(params: RunReadyParams) {
      return { run: ctx.readyRun(params.target, { schedule: params.schedule }) };
    },
    startCliRun(request: CliRunsStartParams) {
      return ctx.startManagedRun({
        ...request,
        webVars: {},
      });
    },
    startWebRun(request: WebRunsStartParams) {
      return ctx.startManagedRun({
        ...request,
        cliVars: {},
      });
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
    setGroup(params: RunSetGroupParams) {
      return { result: ctx.setGroup(params.target, { runGroupId: params.runGroupId }) };
    },
    clearGroup(target: string) {
      return { result: ctx.clearGroup(target) };
    },
    addDependency(target: string, dependency: Parameters<typeof addDependency>[1]) {
      return { result: ctx.addDependency(target, dependency) };
    },
    removeDependency(target: string, dependency: Parameters<typeof removeDependency>[1]) {
      return { result: ctx.removeDependency(target, dependency) };
    },
    clearDependencies(target: string) {
      return { result: ctx.clearDependencies(target) };
    },
    setRunSchedule(params: RunScheduleParams) {
      return { run: ctx.setRunSchedule(params.target, { schedule: params.schedule }) };
    },
    clearRunSchedule(target: string) {
      return { run: ctx.clearRunSchedule(target) };
    },
    setRunScheduleEnabled(target: string, enabled: boolean) {
      return { run: ctx.setRunScheduleEnabled(target, { enabled }) };
    },
    listAttachments(target: string, options?: { scope?: "run" | "group" }) {
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
    async reconfigureRun(params: RunsReconfigureParams) {
      return {
        run: await ctx.reconfigureRun(params.target, {
          vars: params.vars,
          message: params.message,
        }),
      };
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
    getRunInputSurface(params: RunInputSurfaceParams) {
      return {
        inputSurface: ctx.getRunInputSurface(params),
      };
    },
  };
}

export type DaemonOperations = ReturnType<typeof createDaemonOperations>;
