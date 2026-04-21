import type { HookRuntime } from "./runtime";
import {
  extractSessionId,
  extractTaskId,
  extractTaskVerdict,
  resolveSessionID,
  resolveSubagentTaskLane,
  resolveToolArgs,
  resolveToolName,
} from "./runtime";

function hasToolArgs(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}

function resolveEffectiveToolArgs(
  input: unknown,
  output: unknown,
): Record<string, unknown> {
  const inputArgs = resolveToolArgs(input);
  const outputArgs = resolveToolArgs(output);
  if (!hasToolArgs(outputArgs)) {
    return inputArgs;
  }

  for (const [key, value] of Object.entries(inputArgs)) {
    if (!(key in outputArgs)) {
      outputArgs[key] = value;
    }
  }

  return outputArgs;
}

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

      const args = resolveEffectiveToolArgs(input, output);
      const lane = resolveSubagentTaskLane(args.subagent_type);
      const description = resolveTaskDescription(args);
      const taskId =
        typeof args.task_id === "string"
          ? args.task_id
          : lane
            ? runtime.findReusableSubagentTaskId(sessionID, lane, description)
            : undefined;

      if (!args.task_id && taskId) {
        args.task_id = taskId;
      }

      if (!lane || !taskId) {
        return;
      }

      runtime.rememberSubagentTask(
        sessionID,
        lane,
        taskId,
        description,
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

      const description = resolveTaskDescription(args);
      const reviewVerdict = lane === "turing" ? extractTaskVerdict(output) : undefined;
      const childSessionID = extractSessionId(output);
      if (childSessionID && childSessionID !== sessionID) {
        runtime.markSubagentTaskSession(
          childSessionID,
          sessionID,
          lane,
          taskId,
          description,
          reviewVerdict,
        );
        return;
      }

      runtime.rememberSubagentTask(
        sessionID,
        lane,
        taskId,
        description,
        reviewVerdict,
      );
    },
  };
}
