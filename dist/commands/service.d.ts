import { type DefinitionEntry, type DefinitionKind, type LoadedAgent, type LoadedAssignment } from "../config/loader.js";
import { type RunArchiveResult, type RunSummary } from "../contracts/runs.js";
import { ResumeError, type RunManifest, type TaskSnapshot } from "../runner/manifest.js";
export interface StatusCommandResult {
    manifest: RunManifest;
    isLive: boolean;
}
export interface DefinitionListResult {
    kind: DefinitionKind;
    entries: DefinitionEntry[];
}
export type DefinitionDetailsResult = {
    kind: "agent";
    loaded: LoadedAgent;
} | {
    kind: "assignment";
    loaded: LoadedAssignment;
};
export interface RunResetResult {
    manifest: RunManifest;
}
export type RunListEntry = RunSummary;
export type { RunArchiveResult } from "../contracts/runs.js";
export interface RunListResult {
    runs: RunListEntry[];
}
export interface TaskListResult {
    manifest: RunManifest;
    tasks: TaskSnapshot[];
}
export interface TaskDetailsResult {
    manifest: RunManifest;
    task: TaskSnapshot;
}
export interface TaskMutationResult {
    manifest: RunManifest;
    task: TaskSnapshot;
}
export declare class CommandError extends Error {
    constructor(message: string);
}
export declare function readStatus(target: string): StatusCommandResult;
export declare function listDefinitions(kind: DefinitionKind): DefinitionListResult;
export declare function listRuns(opts?: {
    includeArchived?: boolean;
}): RunListResult;
export declare function showDefinition(kind: DefinitionKind, target: string): DefinitionDetailsResult;
export declare function resetRun(target: string): RunResetResult;
export declare function archiveRun(target: string): RunArchiveResult;
export declare function unarchiveRun(target: string): RunArchiveResult;
export declare function listTasks(target: string): TaskListResult;
export declare function showTask(target: string, taskId: string): TaskDetailsResult;
export declare function setTask(target: string, taskId: string, update: {
    status?: string;
    notes?: string;
}): TaskMutationResult;
export declare function appendTaskNotes(target: string, taskId: string, text: string): TaskMutationResult;
export declare function addTask(target: string, input: {
    title: string;
    body?: string;
}): TaskMutationResult;
export declare function isCommandError(err: unknown): err is CommandError | ResumeError;
