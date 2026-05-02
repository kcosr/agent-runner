import builtinCommandHook from "./builtin-command.js";
import builtinGitWorktreeHook from "./builtin-git-worktree.js";
import builtinRequireChildrenSuccessHook from "./builtin-require-children-success.js";
import builtinTaskListHook from "./builtin-task-list.js";
import { HookConfigError } from "./errors.js";
import type { HookModule } from "./types.js";

const BUILTIN_HOOKS: Record<string, HookModule> = {
  command: builtinCommandHook,
  "require-children-success": builtinRequireChildrenSuccessHook,
  "git-worktree": builtinGitWorktreeHook,
  "task-list": builtinTaskListHook,
};

const SKIP_RECONFIGURE_REPLAY_PREPARE_HOOKS = new Set(["task-list"]);

export function builtinHookModule(id: string): HookModule {
  const hook = BUILTIN_HOOKS[id];
  if (!hook) {
    throw new HookConfigError(
      `unknown builtin hook "${id}" (known: ${Object.keys(BUILTIN_HOOKS).join(", ")})`,
    );
  }
  return hook;
}

export function shouldReplayPrepareBuiltinOnReconfigure(id: string): boolean {
  return !SKIP_RECONFIGURE_REPLAY_PREPARE_HOOKS.has(id);
}
