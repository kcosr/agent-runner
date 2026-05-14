import { resolveAgentRunnerCommand } from "../agent-runner-command.js";
import type { Backend, BackendInvokeResult } from "../core/backends/types.js";

export class PassiveBackendNotInvokableError extends Error {
  constructor() {
    const agentRunnerCmd = resolveAgentRunnerCommand();
    super(
      `the passive backend cannot be invoked. Passive agents are driven externally via \`${agentRunnerCmd} task set\` / \`${agentRunnerCmd} task add\`. Use those commands to work the task list and \`${agentRunnerCmd} status\` to read progress.`,
    );
    this.name = "PassiveBackendNotInvokableError";
  }
}

// Null-object backend for sidecar flows. A run with backend=passive is
// never executed by agent-runner — callers `init` it, drive the task
// list through `task set` / `task add`, and check progress with
// `status`. The CLI rejects `agent-runner run` on a passive agent
// before we ever get here, so `invoke` throwing is defense in depth.
export const passiveBackend: Backend = {
  id: "passive",
  launcherMode: "direct",
  async invoke(): Promise<BackendInvokeResult> {
    throw new PassiveBackendNotInvokableError();
  },
};
