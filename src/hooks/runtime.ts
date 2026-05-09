import { type PluginInput } from "@opencode-ai/plugin";
import type { HarnessConfig, HookProfile } from "../types";
import type { OrchestratorLedger } from "../orchestrator/ledger";
import { PRIMARY_AGENT, WORKER_AGENT_SET, type WorkerAgent } from "../orchestrator/constants";
import {
  detectProjectFacts,
  type ProjectFacts,
} from "../project-facts";

type WorkerTaskLane = WorkerAgent;

type WorkerTaskRecord = {
  taskId: string;
  description?: string;
  reviewVerdict?: "approve" | "request-changes";
};

const WORKER_TASK_LANES = new Set<WorkerTaskLane>(
  Array.from(WORKER_AGENT_SET) as WorkerTaskLane[],
);

export function resolveHookProfile(config: HarnessConfig): HookProfile {
  return config.hooks?.profile ?? "standard";
}

export function profileMatches(
  profile: HookProfile,
  allowed: HookProfile | HookProfile[],
): boolean {
  return (Array.isArray(allowed) ? allowed : [allowed]).includes(profile);
}

export const PRIMARY_AGENTS: Set<string> = new Set([PRIMARY_AGENT]);

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

export function resolveWorkerTaskLane(value: unknown): WorkerTaskLane | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return WORKER_TASK_LANES.has(value as WorkerTaskLane)
    ? (value as WorkerTaskLane)
    : undefined;
}

export function extractOpenCodeTaskId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const jsonMatch = value.match(/"task_id"\s*:\s*"(task_[^"]+)"/i);
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
      const taskId = extractOpenCodeTaskId(item);
      if (taskId) {
        return taskId;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct =
    (typeof record.task_id === "string" && record.task_id.startsWith("task_") && record.task_id) ||
    (typeof record.taskId === "string" && record.taskId.startsWith("task_") && record.taskId);
  if (direct) {
    return direct;
  }

  for (const nestedValue of Object.values(record)) {
    const taskId = extractOpenCodeTaskId(nestedValue);
    if (taskId) {
      return taskId;
    }
  }

  return undefined;
}

export function extractLedgerTaskId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const jsonMatch = value.match(/"task_id"\s*:\s*"(T-\d{3,})"/i);
    if (jsonMatch?.[1]) return jsonMatch[1];
    const labeledMatch = value.match(/\b(?:ledger\s+)?task(?:_id| id)?\s*[:=]\s*(T-\d{3,})\b/i);
    if (labeledMatch?.[1]) return labeledMatch[1];
    const plainMatch = value.match(/\bT-\d{3,}\b/);
    return plainMatch?.[0];
  }

  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const taskId = extractLedgerTaskId(item);
      if (taskId) return taskId;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct =
    (typeof record.task_id === "string" && /^T-\d{3,}$/i.test(record.task_id) && record.task_id) ||
    (typeof record.taskId === "string" && /^T-\d{3,}$/i.test(record.taskId) && record.taskId);
  if (direct) return direct;

  for (const nestedValue of Object.values(record)) {
    const taskId = extractLedgerTaskId(nestedValue);
    if (taskId) return taskId;
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

export function createHookRuntime(
  ctx: PluginInput,
  config: HarnessConfig,
  ledger?: OrchestratorLedger,
) {
  const sessionAgents = new Map<string, string>();
  const sessionTaskScopes = new Map<string, string>();
  const taskScopeWorkerTasks = new Map<
    string,
    Map<WorkerTaskLane, Map<string, WorkerTaskRecord>>
  >();
  const activeTaskScopeChildren = new Map<
    string,
    Map<WorkerTaskLane, Map<string, Set<string>>>
  >();
  const childSessionTasks = new Map<
    string,
    { scopeID: string; lane: WorkerTaskLane; taskId: string }
  >();
  const wslMode = ctx.directory.startsWith("/mnt/");
  const wslWinPath = wslMode ? toWindowsPath(ctx.directory) : "";

  function attachDurableSession(
    sessionID: string,
    agent: string | undefined,
    parentSessionID?: string,
  ): void {
    if (!ledger) return;

    const existing = ledger.getSession(sessionID);
    const linkedTask = existing?.active_task_id
      ? ledger.getTask(existing.active_task_id)
      : undefined;
    const mission = linkedTask?.mission_id
      ? ledger.getMission(linkedTask.mission_id)
      : existing?.active_mission_id
        ? ledger.getMission(existing.active_mission_id)
        : ledger.getActiveMission();
    const project = linkedTask?.project_id
      ? ledger.getProject(linkedTask.project_id)
      : existing?.project_id
        ? ledger.getProject(existing.project_id)
        : ledger.resolveProject(ctx.directory) ?? ledger.getOrCreateProject({ root_path: ctx.directory });

    const parent = parentSessionID ? ledger.getSession(parentSessionID) : undefined;
    ledger.attachSession({
      opencode_session_id: sessionID,
      project_id: project?.id,
      cwd: existing?.cwd ?? ctx.directory,
      active_mission_id: linkedTask?.mission_id ?? mission?.id,
      active_task_id: linkedTask?.id,
      agent: agent ?? existing?.agent,
      parent_session_id: parent?.id ?? existing?.parent_session_id,
      metadata: { source: "runtime-hook" },
    });
  }

  function setSessionAgent(sessionID: string, agent: string | undefined): void {
    if (!agent) {
      return;
    }
    sessionAgents.set(sessionID, agent);
    attachDurableSession(sessionID, agent);
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
          const rememberedTasks = taskScopeWorkerTasks
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
      taskScopeWorkerTasks.delete(scopeID);
      activeTaskScopeChildren.delete(scopeID);
    }
    if (ledger?.getSession(sessionID)) {
      ledger.updateSession({
        opencode_session_id: sessionID,
        status: "ended",
        active_task_id: null,
        metadata: { source: "runtime-hook" },
      });
    }
  }

  function resolveTaskScope(sessionID: string): string {
    return sessionTaskScopes.get(sessionID) ?? sessionID;
  }

  function linkWorkerTaskScope(childSessionID: string, parentSessionID: string): void {
    sessionTaskScopes.set(childSessionID, resolveTaskScope(parentSessionID));
    const agent = sessionAgents.get(childSessionID);
    attachDurableSession(childSessionID, agent, parentSessionID);
  }

  function rememberWorkerTask(
    sessionID: string,
    lane: WorkerTaskLane,
    taskId: string,
    description?: string,
    reviewVerdict?: "approve" | "request-changes",
  ): void {
    const scopeID = resolveTaskScope(sessionID);
    const sessionTasks = taskScopeWorkerTasks.get(scopeID) ?? new Map();
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
    taskScopeWorkerTasks.set(scopeID, sessionTasks);
  }

  function markWorkerTaskSession(
    childSessionID: string,
    parentSessionID: string,
    lane: WorkerTaskLane,
    taskId: string,
    description?: string,
    reviewVerdict?: "approve" | "request-changes",
  ): void {
    const scopeID = resolveTaskScope(parentSessionID);
    sessionTaskScopes.set(childSessionID, scopeID);
    rememberWorkerTask(parentSessionID, lane, taskId, description, reviewVerdict);

    const scopeChildren = activeTaskScopeChildren.get(scopeID) ?? new Map();
    const laneChildren = scopeChildren.get(lane) ?? new Map();
    const taskChildren = laneChildren.get(taskId) ?? new Set<string>();

    taskChildren.add(childSessionID);
    laneChildren.set(taskId, taskChildren);
    scopeChildren.set(lane, laneChildren);
    activeTaskScopeChildren.set(scopeID, scopeChildren);
    childSessionTasks.set(childSessionID, { scopeID, lane, taskId });
  }

  function findReusableWorkerTaskId(
    sessionID: string,
    lane: WorkerTaskLane,
    description?: string,
  ): string | undefined {
    const scopeID = resolveTaskScope(sessionID);
    const activeLaneTasks = activeTaskScopeChildren.get(scopeID)?.get(lane);
    if (!activeLaneTasks || activeLaneTasks.size === 0) {
      return undefined;
    }

    const rememberedTasks = taskScopeWorkerTasks.get(scopeID)?.get(lane);
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
        (task): task is WorkerTaskRecord =>
          !!task && task.description?.trim() === normalizedDescription,
      );

    const reusableMatches =
      lane === "verification-engineer"
        ? exactMatches.filter((task) => task.reviewVerdict === "request-changes")
        : exactMatches;

    if (reusableMatches.length === 1) {
      return reusableMatches[0]?.taskId;
    }

    return undefined;
  }

  function buildWorkerSessionHint(sessionID: string): string {
    const tasks = taskScopeWorkerTasks.get(resolveTaskScope(sessionID));
    if (!tasks || tasks.size === 0) {
      return "";
    }

    const parts = Array.from(tasks.entries()).flatMap(([lane, laneTasks]) =>
      Array.from(laneTasks.values()).map((task) =>
        lane === "verification-engineer" && task.reviewVerdict === "approve"
          ? null
          : task.description
            ? lane === "verification-engineer" && task.reviewVerdict === "request-changes"
              ? `${lane}=${task.taskId} (${task.description}) [open-review]`
              : `${lane}=${task.taskId} (${task.description})`
            : lane === "verification-engineer" && task.reviewVerdict === "request-changes"
              ? `${lane}=${task.taskId} [open-review]`
              : `${lane}=${task.taskId}`,
      ),
    ).filter((value): value is string => Boolean(value));

    if (parts.length === 0) {
      return "";
    }

    return `[WorkerSessions] Reuse existing exact-match OpenCode task_ids when safe; verification-engineer threads are reusable only for open repair verification. Seen in this workflow: ${parts.join("; ")}`;
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

  function buildMissionControlInjection(sessionID: string): string {
    return ledger?.buildMissionSnapshot(sessionID) ?? "";
  }

  function buildWorkerTaskInjection(sessionID: string, agent: string): string {
    return ledger?.buildWorkerPacket(sessionID, agent) ?? "";
  }

  function buildCompactionInjection(sessionID: string): string {
    return ledger?.buildCompactionSnapshot(sessionID) ?? "";
  }

  function linkLedgerTaskSession(
    childSessionID: string,
    lane: WorkerTaskLane,
    ledgerTaskID: string,
    parentSessionID?: string,
  ): void {
    if (!ledger) return;
    const task = ledger.getTask(ledgerTaskID);
    if (!task) return;
    const existing = ledger.getSession(childSessionID);
    const parent = parentSessionID ? ledger.getSession(parentSessionID) : undefined;
    const project = task.project_id
      ? ledger.getProject(task.project_id)
      : ledger.resolveProject(ctx.directory) ?? ledger.getOrCreateProject({ root_path: ctx.directory });
    ledger.attachSession({
      opencode_session_id: childSessionID,
      cwd: existing?.cwd ?? ctx.directory,
      project_id: project?.id,
      active_mission_id: task.mission_id,
      active_task_id: task.id,
      agent: lane,
      parent_session_id: parent?.id ?? existing?.parent_session_id,
      metadata: { source: "task-tracking-hook" },
    });
  }

  return {
    detectProjectFacts: (): ProjectFacts => detectProjectFacts(ctx.directory),
    setSessionAgent,
    getSessionAgent,
    clearSession,
    attachDurableSession,
    linkWorkerTaskScope,
    rememberWorkerTask,
    markWorkerTaskSession,
    findReusableWorkerTaskId,
    buildWorkerSessionHint,
    buildMissionControlInjection,
    buildWorkerTaskInjection,
    buildCompactionInjection,
    linkLedgerTaskSession,
    isWsl: (): boolean => wslMode,
    getWslWinPath: (): string => wslWinPath,
    buildPrimaryInjection,
  };
}

export type HookRuntime = ReturnType<typeof createHookRuntime>;
