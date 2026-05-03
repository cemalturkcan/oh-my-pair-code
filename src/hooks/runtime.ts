import { type PluginInput } from "@opencode-ai/plugin";
import type { HarnessConfig, HookProfile } from "../types";
import {
  detectProjectFacts,
  type ProjectFacts,
} from "../project-facts";

type SubagentTaskLane = "eliot" | "tyrell" | "claude" | "turing";

type SubagentTaskRecord = {
  taskId: string;
  description?: string;
  reviewVerdict?: "approve" | "request-changes";
};

const SUBAGENT_TASK_LANES = new Set<SubagentTaskLane>([
  "eliot",
  "tyrell",
  "claude",
  "turing",
]);

export function resolveHookProfile(config: HarnessConfig): HookProfile {
  return config.hooks?.profile ?? "standard";
}

export function profileMatches(
  profile: HookProfile,
  allowed: HookProfile | HookProfile[],
): boolean {
  return (Array.isArray(allowed) ? allowed : [allowed]).includes(profile);
}

export const PRIMARY_AGENTS = new Set(["mrrobot"]);

export function resolveSessionID(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  if (typeof obj.sessionID === "string") return obj.sessionID;

  if (obj.info && typeof obj.info === "object") {
    const info = obj.info as Record<string, unknown>;
    if (typeof info.id === "string") return info.id;
  }

  if (obj.session && typeof obj.session === "object") {
    const session = obj.session as Record<string, unknown>;
    if (typeof session.id === "string") return session.id;
  }

  return undefined;
}

export function resolveSessionOrEntityID(value: unknown): string | undefined {
  const fromSession = resolveSessionID(value);
  if (fromSession) return fromSession;

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === "string") return obj.id;
  }

  return undefined;
}

export function resolveAgentName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  if (typeof obj.agent === "string") return obj.agent;

  if (obj.message && typeof obj.message === "object") {
    const msg = obj.message as Record<string, unknown>;
    if (typeof msg.agent === "string") return msg.agent;
  }

  if (obj.info && typeof obj.info === "object") {
    const info = obj.info as Record<string, unknown>;
    if (typeof info.agent === "string") return info.agent;
  }

  return undefined;
}

export function resolveToolName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  return typeof obj.tool === "string" ? obj.tool : undefined;
}

export function resolveToolArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  return obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
    ? (obj.args as Record<string, unknown>)
    : {};
}

export function resolveSubagentTaskLane(value: unknown): SubagentTaskLane | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value === "michelangelo") {
    return "claude";
  }

  return SUBAGENT_TASK_LANES.has(value as SubagentTaskLane)
    ? (value as SubagentTaskLane)
    : undefined;
}

export function extractTaskId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const jsonMatch = value.match(/"task_id"\s*:\s*"([^"]+)"/i);
    if (jsonMatch?.[1]) {
      return jsonMatch[1];
    }

    const plainMatch = value.match(/\btask_[a-z0-9_-]+\b/i);
    return plainMatch?.[0];
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const taskId = extractTaskId(item);
      if (taskId) {
        return taskId;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct =
    (typeof record.task_id === "string" && record.task_id) ||
    (typeof record.taskId === "string" && record.taskId);
  if (direct) {
    return direct;
  }

  for (const nestedValue of Object.values(record)) {
    const taskId = extractTaskId(nestedValue);
    if (taskId) {
      return taskId;
    }
  }

  return undefined;
}

export function extractTaskVerdict(
  value: unknown,
): "approve" | "request-changes" | undefined {
  if (typeof value === "string") {
    const verdictMatch = value.match(/\bverdict\s*:\s*(approve|request-changes)\b/i);
    if (verdictMatch?.[1] === "approve" || verdictMatch?.[1] === "request-changes") {
      return verdictMatch[1];
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const verdict = extractTaskVerdict(item);
      if (verdict) {
        return verdict;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.verdict === "approve" || record.verdict === "request-changes") {
    return record.verdict;
  }

  for (const nestedValue of Object.values(record)) {
    const verdict = extractTaskVerdict(nestedValue);
    if (verdict) {
      return verdict;
    }
  }

  return undefined;
}

export function extractSessionId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const directMatch = value.match(/"sessionID"\s*:\s*"([^"]+)"/i);
    if (directMatch?.[1]) {
      return directMatch[1];
    }

    const camelMatch = value.match(/"sessionId"\s*:\s*"([^"]+)"/i);
    return camelMatch?.[1];
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const sessionId = extractSessionId(item);
      if (sessionId) {
        return sessionId;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.sessionID === "string") {
    return record.sessionID;
  }
  if (typeof record.sessionId === "string") {
    return record.sessionId;
  }

  if (record.info && typeof record.info === "object") {
    const info = record.info as Record<string, unknown>;
    if (typeof info.id === "string") {
      return info.id;
    }
  }

  if (record.session && typeof record.session === "object") {
    const session = record.session as Record<string, unknown>;
    if (typeof session.id === "string") {
      return session.id;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const sessionId = extractSessionId(nestedValue);
    if (sessionId) {
      return sessionId;
    }
  }

  return undefined;
}

function toWindowsPath(directory: string): string {
  return directory
    .replace(/^\/mnt\/(\w)/, (_, drive: string) => `${drive.toUpperCase()}:`)
    .replace(/\//g, "\\");
}

export function createHookRuntime(ctx: PluginInput, _config: HarnessConfig) {
  const sessionAgents = new Map<string, string>();
  const sessionTaskScopes = new Map<string, string>();
  const taskScopeSubagentTasks = new Map<
    string,
    Map<SubagentTaskLane, Map<string, SubagentTaskRecord>>
  >();
  const activeTaskScopeChildren = new Map<
    string,
    Map<SubagentTaskLane, Map<string, Set<string>>>
  >();
  const childSessionTasks = new Map<
    string,
    { scopeID: string; lane: SubagentTaskLane; taskId: string }
  >();
  const wslMode = ctx.directory.startsWith("/mnt/");
  const wslWinPath = wslMode ? toWindowsPath(ctx.directory) : "";

  function setSessionAgent(sessionID: string, agent: string | undefined): void {
    if (!agent) {
      return;
    }
    sessionAgents.set(sessionID, agent);
  }

  function getSessionAgent(sessionID: string): string | undefined {
    return sessionAgents.get(sessionID);
  }

  function clearSession(sessionID: string): void {
    sessionAgents.delete(sessionID);
    const activeTask = childSessionTasks.get(sessionID);
    if (activeTask) {
      const scopeChildren = activeTaskScopeChildren.get(activeTask.scopeID);
      const laneChildren = scopeChildren?.get(activeTask.lane);
      const taskChildren = laneChildren?.get(activeTask.taskId);
      if (taskChildren) {
        taskChildren.delete(sessionID);
        if (taskChildren.size === 0) {
          laneChildren?.delete(activeTask.taskId);
          const rememberedTasks = taskScopeSubagentTasks
            .get(activeTask.scopeID)
            ?.get(activeTask.lane);
          rememberedTasks?.delete(activeTask.taskId);
        }
        if (laneChildren && laneChildren.size === 0) {
          scopeChildren?.delete(activeTask.lane);
        }
        if (scopeChildren && scopeChildren.size === 0) {
          activeTaskScopeChildren.delete(activeTask.scopeID);
        }
      }
      childSessionTasks.delete(sessionID);
    }
    const scopeID = sessionTaskScopes.get(sessionID) ?? sessionID;
    sessionTaskScopes.delete(sessionID);
    if (scopeID === sessionID) {
      taskScopeSubagentTasks.delete(scopeID);
      activeTaskScopeChildren.delete(scopeID);
    }
  }

  function resolveTaskScope(sessionID: string): string {
    return sessionTaskScopes.get(sessionID) ?? sessionID;
  }

  function linkSubagentTaskScope(childSessionID: string, parentSessionID: string): void {
    sessionTaskScopes.set(childSessionID, resolveTaskScope(parentSessionID));
  }

  function rememberSubagentTask(
    sessionID: string,
    lane: SubagentTaskLane,
    taskId: string,
    description?: string,
    reviewVerdict?: "approve" | "request-changes",
  ): void {
    const scopeID = resolveTaskScope(sessionID);
    const sessionTasks = taskScopeSubagentTasks.get(scopeID) ?? new Map();
    const laneTasks = sessionTasks.get(lane) ?? new Map();
    const previous = laneTasks.get(taskId);
    laneTasks.set(taskId, {
      taskId,
      ...((description || previous?.description)
        ? { description: description || previous?.description }
        : {}),
      ...((reviewVerdict || previous?.reviewVerdict)
        ? { reviewVerdict: reviewVerdict || previous?.reviewVerdict }
        : {}),
    });
    sessionTasks.set(lane, laneTasks);
    taskScopeSubagentTasks.set(scopeID, sessionTasks);
  }

  function markSubagentTaskSession(
    childSessionID: string,
    parentSessionID: string,
    lane: SubagentTaskLane,
    taskId: string,
    description?: string,
    reviewVerdict?: "approve" | "request-changes",
  ): void {
    const scopeID = resolveTaskScope(parentSessionID);
    sessionTaskScopes.set(childSessionID, scopeID);
    rememberSubagentTask(parentSessionID, lane, taskId, description, reviewVerdict);

    const scopeChildren = activeTaskScopeChildren.get(scopeID) ?? new Map();
    const laneChildren = scopeChildren.get(lane) ?? new Map();
    const taskChildren = laneChildren.get(taskId) ?? new Set<string>();

    taskChildren.add(childSessionID);
    laneChildren.set(taskId, taskChildren);
    scopeChildren.set(lane, laneChildren);
    activeTaskScopeChildren.set(scopeID, scopeChildren);
    childSessionTasks.set(childSessionID, { scopeID, lane, taskId });
  }

  function findReusableSubagentTaskId(
    sessionID: string,
    lane: SubagentTaskLane,
    description?: string,
  ): string | undefined {
    const scopeID = resolveTaskScope(sessionID);
    const activeLaneTasks = activeTaskScopeChildren.get(scopeID)?.get(lane);
    if (!activeLaneTasks || activeLaneTasks.size === 0) {
      return undefined;
    }

    const rememberedTasks = taskScopeSubagentTasks.get(scopeID)?.get(lane);
    if (!rememberedTasks) {
      return undefined;
    }

    const normalizedDescription = description?.trim();
    if (!normalizedDescription) {
      return undefined;
    }

    const exactMatches = Array.from(activeLaneTasks.keys())
      .map((taskId) => rememberedTasks.get(taskId))
      .filter(
        (task): task is SubagentTaskRecord =>
          !!task && task.description?.trim() === normalizedDescription,
      );

    const reusableMatches =
      lane === "turing"
        ? exactMatches.filter((task) => task.reviewVerdict === "request-changes")
        : exactMatches;

    if (reusableMatches.length === 1) {
      return reusableMatches[0]?.taskId;
    }

    return undefined;
  }

  function buildSubagentTaskInjection(sessionID: string): string {
    const tasks = taskScopeSubagentTasks.get(resolveTaskScope(sessionID));
    if (!tasks || tasks.size === 0) {
      return "";
    }

    const parts = Array.from(tasks.entries()).flatMap(([lane, laneTasks]) =>
      Array.from(laneTasks.values()).map((task) =>
        lane === "turing" && task.reviewVerdict === "approve"
          ? null
          : task.description
            ? lane === "turing" && task.reviewVerdict === "request-changes"
              ? `${lane}=${task.taskId} (${task.description}) [open-review]`
              : `${lane}=${task.taskId} (${task.description})`
            : lane === "turing" && task.reviewVerdict === "request-changes"
              ? `${lane}=${task.taskId} [open-review]`
              : `${lane}=${task.taskId}`,
      ),
    ).filter((value): value is string => Boolean(value));

    if (parts.length === 0) {
      return "";
    }

    return `[SubagentTasks] Reuse existing exact-match task_ids when safe; Turing threads are reusable only for open repair verification. Seen in this workflow: ${parts.join("; ")}`;
  }

  function buildPrimaryInjection(): string {
    if (!wslMode) {
      return "";
    }

    return [
      `[WSL] Windows project at ${wslWinPath}. Read/Edit via /mnt/ paths.`,
      "Node tools (npm/pnpm/yarn/bun/npx/bunx/node/tsc/tsx/vite/next/nuxt/vitest/jest/eslint/prettier): run via cmd.exe.",
      "Git/SSH/curl/grep: WSL bash OK.",
    ].join("\n");
  }

  return {
    detectProjectFacts: (): ProjectFacts => detectProjectFacts(ctx.directory),
    setSessionAgent,
    getSessionAgent,
    clearSession,
    linkSubagentTaskScope,
    rememberSubagentTask,
    markSubagentTaskSession,
    findReusableSubagentTaskId,
    buildSubagentTaskInjection,
    isWsl: (): boolean => wslMode,
    getWslWinPath: (): string => wslWinPath,
    buildPrimaryInjection,
  };
}

export type HookRuntime = ReturnType<typeof createHookRuntime>;
