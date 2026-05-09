import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type WebAgentDaemonConfig = {
  host: "127.0.0.1";
  port: number;
  dataDir: string;
  profileDir: string;
  registryPath: string;
  lockPath: string;
  endpoint: string;
};

export type WebAgentDaemonRegistry = {
  pid: number;
  endpoint: string;
  host: string;
  port: number;
  dataDir: string;
  profileDir: string;
  startedAt: string;
  version: string;
};

function appDataRoot(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  return xdgDataHome || path.join(homedir(), ".local", "share");
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "29741");
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid WEB_AGENT_DAEMON_PORT: ${value}`);
  }
  return parsed;
}

export function getDaemonConfig(source: NodeJS.ProcessEnv = process.env): WebAgentDaemonConfig {
  const dataDir = source.WEB_AGENT_DAEMON_DATA_DIR?.trim()
    || path.join(appDataRoot(), "opencode-pair", "web-agent");
  const host = "127.0.0.1" as const;
  const port = parsePort(source.WEB_AGENT_DAEMON_PORT);
  return {
    host,
    port,
    dataDir,
    profileDir: path.join(dataDir, "profile"),
    registryPath: path.join(dataDir, "daemon.json"),
    lockPath: path.join(dataDir, "profile.lock"),
    endpoint: `http://${host}:${port}/mcp`,
  };
}

export function readDaemonRegistry(config = getDaemonConfig()): WebAgentDaemonRegistry | undefined {
  if (!existsSync(config.registryPath)) return undefined;
  try {
    return JSON.parse(readFileSync(config.registryPath, "utf8")) as WebAgentDaemonRegistry;
  } catch {
    return undefined;
  }
}

export function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(config = getDaemonConfig()): boolean {
  return isProcessRunning(readDaemonRegistry(config)?.pid);
}

export function acquireProfileLock(config = getDaemonConfig()): number {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.profileDir, { recursive: true });

  try {
    return openSync(config.lockPath, "wx");
  } catch (error) {
    const registry = readDaemonRegistry(config);
    if (isProcessRunning(registry?.pid)) {
      throw new Error(
        `web-agent daemon profile is already owned by pid ${registry?.pid}; refusing duplicate browser ownership.`,
      );
    }
    rmSync(config.lockPath, { force: true });
    return openSync(config.lockPath, "wx");
  }
}

export function writeDaemonRegistry(
  config: WebAgentDaemonConfig,
  input: Omit<WebAgentDaemonRegistry, "pid" | "endpoint" | "host" | "port" | "dataDir" | "profileDir" | "startedAt">,
): WebAgentDaemonRegistry {
  const registry = {
    pid: process.pid,
    endpoint: config.endpoint,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    profileDir: config.profileDir,
    startedAt: new Date().toISOString(),
    version: input.version,
  } satisfies WebAgentDaemonRegistry;
  writeFileSync(config.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}

export function releaseProfileLock(fd: number | undefined, config = getDaemonConfig()): void {
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {}
  }
  rmSync(config.lockPath, { force: true });
}
