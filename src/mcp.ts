import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { HarnessConfig } from "./types";

type McpConfig = Record<string, unknown>;

const DEFAULT_MCP_TIMEOUT_MS = 60000;
const IMAGE_GEN_MCP_TIMEOUT_MS = 300000;

const LOCAL_MCP_DEPENDENCIES = {
  "web-agent-mcp": [
    "@modelcontextprotocol/sdk",
    "zod",
    "cloakbrowser",
    "playwright-core",
  ],
  "pg-mcp": ["@modelcontextprotocol/sdk", "pg"],
  "ssh-mcp": ["@modelcontextprotocol/sdk", "zod"],
  "openai-image-gen-mcp": ["@modelcontextprotocol/sdk"],
} as const;

function hasDisplay(): boolean {
  if (process.platform !== "linux") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function sharedConfigRoot(): string {
  const xdgRoot = process.env.XDG_CONFIG_HOME?.trim();
  return xdgRoot || join(homedir(), ".config");
}

function sharedDataRoot(): string {
  const xdgRoot = process.env.XDG_DATA_HOME?.trim();
  return xdgRoot || join(homedir(), ".local", "share");
}

function webAgentDaemonRoot(): string {
  return process.env.WEB_AGENT_DAEMON_DATA_DIR?.trim()
    || join(sharedDataRoot(), "opencode-pair", "web-agent");
}

function webAgentDaemonPort(): number {
  const parsed = Number(process.env.WEB_AGENT_DAEMON_PORT ?? "29741");
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 29741;
}

function webAgentDaemonEndpoint(): string {
  return `http://127.0.0.1:${webAgentDaemonPort()}/mcp`;
}

function webAgentDaemonRegistryPath(): string {
  return join(webAgentDaemonRoot(), "daemon.json");
}

function readDaemonPid(): number | undefined {
  try {
    const registry = JSON.parse(readFileSync(webAgentDaemonRegistryPath(), "utf8")) as { pid?: number };
    return registry.pid;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function ensureWebAgentDaemon(serverEntry: string): { endpoint: string; started: boolean; running: boolean } {
  const endpoint = webAgentDaemonEndpoint();
  if (isProcessRunning(readDaemonPid())) {
    return { endpoint, started: false, running: true };
  }

  const dataDir = webAgentDaemonRoot();
  mkdirSync(dataDir, { recursive: true });
  const profileDir = join(dataDir, "profile");
  const child = spawn("bun", ["run", serverEntry, "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEB_AGENT_DAEMON: "true",
      WEB_AGENT_DAEMON_DATA_DIR: dataDir,
      WEB_AGENT_CHROME_USER_DATA_DIR: profileDir,
      WEB_AGENT_HEADLESS: hasDisplay() ? "false" : "true",
      WEB_AGENT_DEFAULT_LAUNCH_ARGS: hasDisplay()
        ? ""
        : "--disable-gpu,--disable-dev-shm-usage",
    },
  });
  child.unref();
  writeFileSync(join(dataDir, "controller.json"), JSON.stringify({ endpoint, pid: child.pid, startedAt: new Date().toISOString() }, null, 2), "utf8");
  return { endpoint, started: true, running: false };
}

export function getManagedMcpRoot(name: string): string {
  return join(sharedConfigRoot(), name);
}

function localCommand(scriptPath: string): string[] {
  return ["node", scriptPath];
}

function hasInstalledPackage(serverRoot: string, packageName: string): boolean {
  return existsSync(join(serverRoot, "node_modules", ...packageName.split("/")));
}

function hasRequiredPackages(
  name: keyof typeof LOCAL_MCP_DEPENDENCIES,
  serverRoot: string,
): boolean {
  return LOCAL_MCP_DEPENDENCIES[name].every((pkg) =>
    hasInstalledPackage(serverRoot, pkg),
  );
}

export function createHarnessMcps(
  config: HarnessConfig,
): Record<string, McpConfig> {
  const toggles = config.mcps ?? {};
  const result: Record<string, McpConfig> = {};

  if (toggles.context7 !== false) {
    result.context7 = {
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
      headers: process.env.CONTEXT7_API_KEY
        ? { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` }
        : undefined,
      oauth: false,
      timeout: DEFAULT_MCP_TIMEOUT_MS,
    };
  }

  if (toggles.grep_app !== false) {
    result.grep_app = {
      type: "remote",
      url: "https://mcp.grep.app",
      enabled: true,
      oauth: false,
      timeout: DEFAULT_MCP_TIMEOUT_MS,
    };
  }

  if (toggles.web_agent_mcp !== false) {
    const serverRoot = getManagedMcpRoot("web-agent-mcp");
    const serverEntry = join(serverRoot, "src", "server.ts");
    if (existsSync(serverEntry) && hasRequiredPackages("web-agent-mcp", serverRoot)) {
      if (process.env.OPENCODE_PAIR_WEB_AGENT_DAEMON === "false") {
        result["web-agent-mcp"] = {
          type: "local",
          command: ["bun", "run", serverEntry],
          environment: {
            WEB_AGENT_CHROME_USER_DATA_DIR: join(webAgentDaemonRoot(), "profile"),
            WEB_AGENT_HEADLESS: hasDisplay() ? "false" : "true",
            WEB_AGENT_DEFAULT_LAUNCH_ARGS: hasDisplay()
              ? ""
              : "--disable-gpu,--disable-dev-shm-usage",
          },
          enabled: true,
          timeout: DEFAULT_MCP_TIMEOUT_MS,
        };
      } else {
        const daemon = ensureWebAgentDaemon(serverEntry);
        result["web-agent-mcp"] = {
          type: "remote",
          url: daemon.endpoint,
          enabled: true,
          oauth: false,
          timeout: DEFAULT_MCP_TIMEOUT_MS,
        };
      }
    }
  }

  if (toggles.pg_mcp !== false) {
    const serverRoot = getManagedMcpRoot("pg-mcp");
    const pgConfigPath = join(serverRoot, "config.json");
    const serverEntry = join(serverRoot, "src", "index.js");
    if (
      existsSync(serverEntry) &&
      existsSync(pgConfigPath) &&
      hasRequiredPackages("pg-mcp", serverRoot)
    ) {
      result["pg-mcp"] = {
        type: "local",
        command: localCommand(serverEntry),
        environment: {
          PG_MCP_CONFIG_PATH: pgConfigPath,
        },
        enabled: true,
        timeout: DEFAULT_MCP_TIMEOUT_MS,
      };
    }
  }

  if (toggles.ssh_mcp !== false) {
    const serverRoot = getManagedMcpRoot("ssh-mcp");
    const sshConfigPath = join(serverRoot, "config.json");
    const serverEntry = join(serverRoot, "src", "index.js");
    if (
      existsSync(serverEntry) &&
      existsSync(sshConfigPath) &&
      hasRequiredPackages("ssh-mcp", serverRoot)
    ) {
      result["ssh-mcp"] = {
        type: "local",
        command: localCommand(serverEntry),
        environment: {
          SSH_MCP_CONFIG_PATH: sshConfigPath,
        },
        enabled: true,
        timeout: DEFAULT_MCP_TIMEOUT_MS,
      };
    }
  }

  if (toggles.openai_image_gen_mcp !== false) {
    const serverRoot = getManagedMcpRoot("openai-image-gen-mcp");
    const configPath = join(serverRoot, "config.json");
    const serverEntry = join(serverRoot, "src", "index.js");
    if (existsSync(serverEntry) && hasRequiredPackages("openai-image-gen-mcp", serverRoot)) {
      result["openai-image-gen-mcp"] = {
        type: "local",
        command: localCommand(serverEntry),
        environment: {
          OPENAI_IMAGE_GEN_CONFIG_PATH: configPath,
        },
        enabled: true,
        timeout: IMAGE_GEN_MCP_TIMEOUT_MS,
      };
    }
  }

  if (toggles.searxng !== false) {
    const searxngUrl = process.env.SEARXNG_URL?.trim() || "http://localhost:8099";
    result.searxng = {
      type: "local",
      command: ["npx", "-y", "mcp-searxng"],
      environment: {
        SEARXNG_URL: searxngUrl,
      },
      enabled: true,
      timeout: DEFAULT_MCP_TIMEOUT_MS,
    };
  }

  if (toggles.mariadb !== false) {
    result.mariadb = {
      type: "local",
      command: ["npx", "-y", "@cemalturkcann/mariadb-mcp-server"],
      enabled: true,
      timeout: DEFAULT_MCP_TIMEOUT_MS,
    };
  }

  return result;
}
