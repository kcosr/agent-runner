import type {
  addDependency,
  addRunAttachmentFromStream,
  appendNotes,
  archive,
  cleanupRunEnvironment,
  clearBackendSession,
  clearDependencies,
  clearGroup,
  clearRunSchedule,
  createTask,
  deleteArchivedRun,
  drainQueuedResumeMessages,
  getAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunAuditHistory,
  getRunBrief,
  getRunEnvironment,
  getRunInputSurface,
  getRunList,
  getRunSummary,
  getRunTimelineHistory,
  getTask,
  getTaskList,
  getWorkspaceFile,
  getWorkspaceFileList,
  getWorkspaceFileSearch,
  initRun,
  queueResumeMessage,
  readyRun,
  reconfigureRun,
  removeDependency,
  removeQueuedResumeMessage,
  removeRunAttachment,
  removeTask,
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
  validateRunEnvironment,
} from "@kcosr/agent-runner-core/app/service.js";
import type {
  CliRunsStartParams,
  DaemonInfo,
  DefinitionGetParams,
  RunInputSurfaceParams,
  RunQueueResumeMessageParams,
  RunReadyParams,
  RunRemoveQueuedResumeMessageParams,
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
  getRunEnvironment: typeof getRunEnvironment;
  getRunList: typeof getRunList;
  getRunSummary: typeof getRunSummary;
  getRunAuditHistory: typeof getRunAuditHistory;
  getRunTimelineHistory: typeof getRunTimelineHistory;
  getWorkspaceFileList: typeof getWorkspaceFileList;
  getWorkspaceFileSearch: typeof getWorkspaceFileSearch;
  getWorkspaceFile: typeof getWorkspaceFile;
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
  validateRunEnvironment: typeof validateRunEnvironment;
  cleanupRunEnvironment: typeof cleanupRunEnvironment;
  setRunScheduleEnabled: typeof setRunScheduleEnabled;
  addRunAttachmentFromStream: typeof addRunAttachmentFromStream;
  removeRunAttachment: typeof removeRunAttachment;
  reset: typeof reset;
  reconfigureRun: typeof reconfigureRun;
  updateTask: typeof updateTask;
  appendNotes: typeof appendNotes;
  createTask: typeof createTask;
  removeTask: typeof removeTask;
  initRun: typeof initRun;
  readyRun: typeof readyRun;
  queueResumeMessage: typeof queueResumeMessage;
  removeQueuedResumeMessage: typeof removeQueuedResumeMessage;
  drainQueuedResumeMessages: typeof drainQueuedResumeMessages;
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
    listWorkspaceFiles(target: string, input?: { path?: string }) {
      return { directory: ctx.getWorkspaceFileList(target, input) };
    },
    searchWorkspaceFiles(target: string, input: { query: string; limit?: number }) {
      return { search: ctx.getWorkspaceFileSearch(target, input) };
    },
    getWorkspaceFile(target: string, input: { path: string }) {
      return { file: ctx.getWorkspaceFile(target, input) };
    },
    getRunBrief(target: string) {
      return { brief: ctx.getRunBrief(target) };
    },
    getRunEnvironment(target: string) {
      return ctx.getRunEnvironment(target);
    },
    validateRunEnvironment(target: string) {
      return ctx.validateRunEnvironment(target);
    },
    cleanupRunEnvironment(target: string) {
      return ctx.cleanupRunEnvironment(target);
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
    queueResumeMessage(params: RunQueueResumeMessageParams) {
      return ctx.queueResumeMessage({
        target: params.target,
        message: params.message,
      });
    },
    removeQueuedResumeMessage(params: RunRemoveQueuedResumeMessageParams) {
      return ctx.removeQueuedResumeMessage({
        target: params.target,
        messageId: params.messageId,
      });
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
    async deleteRun(target: string) {
      return { result: await ctx.deleteArchivedRun(target) };
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
    async resetRun(target: string) {
      return { run: await ctx.reset(target) };
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
    async removeTask(target: string, taskId: string) {
      return { result: await ctx.removeTask(target, taskId) };
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
    listEnvironments() {
      return { environments: ctx.getDefinitionList("environment") };
    },
    getEnvironment(params: DefinitionGetParams) {
      return {
        environment: ctx.getDefinition("environment", params.target, params.cwd),
      };
    },
    listTaskDefinitions() {
      return { taskDefinitions: ctx.getDefinitionList("task") };
    },
    getTaskDefinition(params: DefinitionGetParams) {
      return {
        taskDefinition: ctx.getDefinition("task", params.target, params.cwd),
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
