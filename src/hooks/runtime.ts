import { type PluginInput } from "@opencode-ai/plugin";
import type { HarnessConfig, HookProfile } from "../types";
import {
  detectProjectFacts,
  type ProjectFacts,
} from "../project-facts";

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

function toWindowsPath(directory: string): string {
  return directory
    .replace(/^\/mnt\/(\w)/, (_, drive: string) => `${drive.toUpperCase()}:`)
    .replace(/\//g, "\\");
}

export function createHookRuntime(ctx: PluginInput, _config: HarnessConfig) {
  const sessionAgents = new Map<string, string>();
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
    isWsl: (): boolean => wslMode,
    getWslWinPath: (): string => wslWinPath,
    buildPrimaryInjection,
  };
}

export type HookRuntime = ReturnType<typeof createHookRuntime>;
