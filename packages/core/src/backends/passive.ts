import type { Backend, BackendInvokeResult } from "../core/backends/types.js";
import { resolveTaskRunnerCommand } from "../task-runner-command.js";

export class PassiveBackendNotInvokableError extends Error {
  constructor() {
    const taskRunnerCmd = resolveTaskRunnerCommand();
    super(
      `the passive backend cannot be invoked. Passive agents are driven externally via \`${taskRunnerCmd} task set\` / \`${taskRunnerCmd} task add\`. Use those commands to work the task list and \`${taskRunnerCmd} status\` to read progress.`,
    );
    this.name = "PassiveBackendNotInvokableError";
  }
}

// Null-object backend for sidecar flows. A run with backend=passive is
// never executed by task-runner — callers `init` it, drive the task
// list through `task set` / `task add`, and check progress with
// `status`. The CLI rejects `task-runner run` on a passive agent
// before we ever get here, so `invoke` throwing is defense in depth.
export const passiveBackend: Backend = {
  id: "passive",
  launcherMode: "direct",
  async invoke(): Promise<BackendInvokeResult> {
    throw new PassiveBackendNotInvokableError();
  },
};
