import type { HookRuntime } from "./runtime";
import {
  extractSessionId,
  extractTaskId,
  resolveSessionID,
  resolveSubagentTaskLane,
  resolveToolArgs,
  resolveToolName,
} from "./runtime";

function resolveTaskDescription(args: Record<string, unknown>): string | undefined {
  return typeof args.description === "string" && args.description.trim().length > 0
    ? args.description.trim()
    : undefined;
}

export function createTaskTrackingHook(runtime: HookRuntime) {
  return {
    "tool.execute.before": async (
      input: unknown,
      output: unknown,
    ): Promise<void> => {
      if (resolveToolName(input) !== "task") {
        return;
      }

      const sessionID = resolveSessionID(input);
      if (!sessionID) {
        return;
      }

      const args = { ...resolveToolArgs(input), ...resolveToolArgs(output) };
      const lane = resolveSubagentTaskLane(args.subagent_type);
      const taskId = typeof args.task_id === "string" ? args.task_id : undefined;

      if (!lane || !taskId) {
        return;
      }

      runtime.rememberSubagentTask(
        sessionID,
        lane,
        taskId,
        resolveTaskDescription(args),
      );
    },
    "tool.execute.after": async (input: unknown, output: unknown): Promise<void> => {
      if (resolveToolName(input) !== "task") {
        return;
      }

      const sessionID = resolveSessionID(input);
      if (!sessionID) {
        return;
      }

      const args = resolveToolArgs(input);
      const lane = resolveSubagentTaskLane(args.subagent_type);
      if (!lane) {
        return;
      }

      const taskId = extractTaskId(output) ?? extractTaskId(args.task_id);
      if (!taskId) {
        return;
      }

      const childSessionID = extractSessionId(output);
      if (childSessionID && childSessionID !== sessionID) {
        runtime.linkSubagentTaskScope(childSessionID, sessionID);
      }

      runtime.rememberSubagentTask(
        sessionID,
        lane,
        taskId,
        resolveTaskDescription(args),
      );
    },
  };
}
