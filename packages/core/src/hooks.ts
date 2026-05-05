/**
 * Public hook-authoring entrypoint for assignment hooks.
 *
 * Hook files should import their types and `defineHook(...)` from here
 * instead of reaching into internal `core/` paths.
 */
export {
  defineHook,
  type AttemptHookContext,
  type HookAuditRecord,
  type HookModule,
  type HookMutations,
  type HookResult,
  type HookTaskPatch,
  type HookContextTasks,
  type PrepareHookContext,
  type ResolvedTask,
  type ResolvedHookDescriptor,
  type TaskTransitionHookContext,
  type TaskTransitionResult,
} from "./core/hooks/types.js";
export type { TaskTransitionHookEntry } from "./core/config/schema.js";
