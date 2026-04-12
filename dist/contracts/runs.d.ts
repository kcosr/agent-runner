import type { LockableField, TaskMode } from "../config/schema.js";
import type { TaskSnapshot } from "../runner/manifest.js";
import type { ListedRunManifest, ManifestStatus, RunManifest } from "../runner/manifest.js";
export type RunStatus = ManifestStatus;
export interface RunSummary {
    runId: string;
    repo: string;
    status: RunStatus;
    archivedAt: string | null;
    agentName: string;
    assignmentName: string | null;
    backend: string;
    model: string | null;
    sessionName: string | null;
    cwd: string;
    startedAt: string;
    endedAt: string | null;
    tasksCompleted: number;
    tasksTotal: number;
}
export interface RunTaskSummary {
    id: string;
    title: string;
    body: string;
    status: TaskSnapshot["status"];
    notes: string;
}
export interface RunCapabilities {
    canArchive: boolean;
    canUnarchive: boolean;
    canResume: boolean;
    canAbort: boolean;
    canMutateTasks: boolean;
}
export interface RunDetailInput {
    manifest: RunManifest;
    isLive: boolean;
}
export interface RunDetail {
    runId: string;
    status: RunStatus;
    archivedAt: string | null;
    isLive: boolean;
    agent: {
        name: string;
        sourcePath: string | null;
    };
    assignment: {
        name: string;
        sourcePath: string;
        workspacePath: string;
    } | null;
    backend: string;
    model: string | null;
    effort: string | null;
    sessionName: string | null;
    backendSessionId: string | null;
    cwd: string;
    taskMode: TaskMode;
    unrestricted: boolean;
    timeoutSec: number;
    startedAt: string;
    endedAt: string | null;
    exitCode: number | null;
    attempts: number;
    maxAttempts: number;
    tasksCompleted: number;
    tasksTotal: number;
    tasks: RunTaskSummary[];
    message: string | null;
    callerInstructions: string | null;
    pendingPrompt: string | null;
    lockedFields: LockableField[];
    runtimeVars: Record<string, unknown>;
    capabilities: RunCapabilities;
}
export interface RunArchiveResult {
    runId: string;
    status: RunStatus;
    archivedAt: string | null;
    changed: boolean;
}
export interface RunActionTarget {
    target: string;
}
export declare function toRunSummary(entry: ListedRunManifest): RunSummary;
export declare function deriveRunCapabilities(manifest: RunManifest): RunCapabilities;
export declare function toRunDetail(result: RunDetailInput): RunDetail;
export declare function toRunArchiveResult(result: {
    manifest: RunManifest;
    changed: boolean;
}): RunArchiveResult;
