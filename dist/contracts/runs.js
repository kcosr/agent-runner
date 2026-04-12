import { normalizeTaskMode } from "../config/schema.js";
function toRunTaskSummary(task) {
    return {
        id: task.id,
        title: task.title,
        body: task.body,
        status: task.status,
        notes: task.notes,
    };
}
export function toRunSummary(entry) {
    return {
        runId: entry.manifest.runId,
        repo: entry.repo,
        status: entry.manifest.status,
        archivedAt: entry.manifest.archivedAt,
        agentName: entry.manifest.agent.name,
        assignmentName: entry.manifest.assignment?.name ?? null,
        backend: entry.manifest.backend,
        model: entry.manifest.model,
        sessionName: entry.manifest.sessionName,
        cwd: entry.manifest.cwd,
        startedAt: entry.manifest.startedAt,
        endedAt: entry.manifest.endedAt,
        tasksCompleted: entry.manifest.tasksCompleted,
        tasksTotal: entry.manifest.tasksTotal,
    };
}
export function deriveRunCapabilities(manifest) {
    const isRunning = manifest.status === "running";
    const isArchived = manifest.archivedAt !== null;
    const isCliModeRun = normalizeTaskMode(manifest.taskMode) === "cli";
    return {
        canArchive: !isRunning && !isArchived,
        canUnarchive: !isRunning && isArchived,
        canResume: !isRunning && !isArchived && manifest.backend !== "passive",
        canAbort: false,
        canMutateTasks: !isRunning || isCliModeRun,
    };
}
export function toRunDetail(result) {
    const { manifest } = result;
    return {
        runId: manifest.runId,
        status: manifest.status,
        archivedAt: manifest.archivedAt,
        isLive: result.isLive,
        agent: {
            name: manifest.agent.name,
            sourcePath: manifest.agent.sourcePath,
        },
        assignment: manifest.assignment
            ? {
                name: manifest.assignment.name,
                sourcePath: manifest.assignment.sourcePath,
                workspacePath: manifest.assignment.workspacePath,
            }
            : null,
        backend: manifest.backend,
        model: manifest.model,
        effort: manifest.effort,
        sessionName: manifest.sessionName,
        backendSessionId: manifest.backendSessionId,
        cwd: manifest.cwd,
        taskMode: normalizeTaskMode(manifest.taskMode),
        unrestricted: manifest.unrestricted,
        timeoutSec: manifest.timeoutSec,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt,
        exitCode: manifest.exitCode,
        attempts: manifest.attempts,
        maxAttempts: manifest.maxAttempts,
        tasksCompleted: manifest.tasksCompleted,
        tasksTotal: manifest.tasksTotal,
        tasks: Object.values(manifest.finalTasks).map(toRunTaskSummary),
        message: manifest.message,
        callerInstructions: manifest.callerInstructions,
        pendingPrompt: manifest.pendingPrompt,
        lockedFields: [...manifest.lockedFields],
        runtimeVars: { ...manifest.runtimeVars },
        capabilities: deriveRunCapabilities(manifest),
    };
}
export function toRunArchiveResult(result) {
    return {
        runId: result.manifest.runId,
        status: result.manifest.status,
        archivedAt: result.manifest.archivedAt,
        changed: result.changed,
    };
}
