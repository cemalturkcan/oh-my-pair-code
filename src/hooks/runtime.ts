import { type PluginInput } from "@opencode-ai/plugin";
import type { HarnessConfig, HookProfile } from "../types";
import {
  detectProjectFacts,
  type ProjectFacts,
} from "../project-facts";

type SubagentTaskLane = "eliot" | "tyrell" | "michelangelo" | "turing";

type SubagentTaskRecord = {
  taskId: string;
  description?: string;
};

const SUBAGENT_TASK_LANES = new Set<SubagentTaskLane>([
  "eliot",
  "tyrell",
  "michelangelo",
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

export const PRIMARY_AGENTS = new Set(["mrrobot", "wick"]);

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
    const scopeID = sessionTaskScopes.get(sessionID) ?? sessionID;
    sessionTaskScopes.delete(sessionID);
    if (scopeID === sessionID) {
      taskScopeSubagentTasks.delete(scopeID);
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
    });
    sessionTasks.set(lane, laneTasks);
    taskScopeSubagentTasks.set(scopeID, sessionTasks);
  }

  function buildSubagentTaskInjection(sessionID: string): string {
    const tasks = taskScopeSubagentTasks.get(resolveTaskScope(sessionID));
    if (!tasks || tasks.size === 0) {
      return "";
    }

    const parts = Array.from(tasks.entries()).flatMap(([lane, laneTasks]) =>
      Array.from(laneTasks.values()).map((task) =>
        task.description
          ? `${lane}=${task.taskId} (${task.description})`
          : `${lane}=${task.taskId}`,
      ),
    );

    return `[SubagentTasks] Reuse existing task_ids for the same lane and workstream before spawning a fresh subagent. Seen in this workflow: ${parts.join("; ")}`;
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
    buildSubagentTaskInjection,
    isWsl: (): boolean => wslMode,
    getWslWinPath: (): string => wslWinPath,
    buildPrimaryInjection,
  };
}

export type HookRuntime = ReturnType<typeof createHookRuntime>;
