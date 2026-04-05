import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "./types";

type McpConfig = Record<string, unknown>;

function hasDisplay(): boolean {
  if (process.platform !== "linux") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function configRoot(): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (envDir) {
    return envDir;
  }
  return join(homedir(), ".config", "opencode");
}

function vendorRoot(): string {
  return join(configRoot(), "vendor");
}

function binRoot(): string {
  return join(configRoot(), "bin");
}

function resolveVendorMcpPath(name: string): string {
  return join(vendorRoot(), "mcp", name);
}

function resolveMcpServerRoot(name: string): string {
  const vendorPath = resolveVendorMcpPath(name);
  if (existsSync(vendorPath)) {
    return vendorPath;
  }
  return join(configRoot(), "mcp", name);
}

function localCommand(scriptPath: string): string[] {
  return ["node", scriptPath];
}

function commandExistsInPath(command: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return false;
  }

  const executableNames =
    process.platform === "win32"
      ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
      : [command];

  return pathValue
    .split(process.platform === "win32" ? ";" : ":")
    .some((directory) =>
      executableNames.some((name) => existsSync(join(directory, name))),
    );
}

export function createHarnessMcps(
  config: HarnessConfig,
): Record<string, McpConfig> {
  const toggles = config.mcps ?? {};
  const result: Record<string, McpConfig> = {};
  const root = configRoot();

  if (toggles.context7 !== false) {
    result.context7 = {
      type: "remote",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
      headers: process.env.CONTEXT7_API_KEY
        ? { Authorization: `Bearer ${process.env.CONTEXT7_API_KEY}` }
        : undefined,
      oauth: false,
      timeout: 60000,
    };
  }

  if (toggles.grep_app !== false) {
    result.grep_app = {
      type: "remote",
      url: "https://mcp.grep.app",
      enabled: true,
      oauth: false,
      timeout: 60000,
    };
  }

  if (toggles.web_agent_mcp !== false) {
    const serverRoot = resolveMcpServerRoot("web-agent-mcp");
    const serverEntry = join(serverRoot, "src", "server.ts");
    if (existsSync(serverEntry)) {
      result["web-agent-mcp"] = {
        type: "local",
        command: ["bun", "run", serverEntry],
        environment: {
          WEB_AGENT_CHROME_USER_DATA_DIR: join(
            homedir(),
            ".config",
            "default-profile",
          ),
          WEB_AGENT_HEADLESS: hasDisplay() ? "false" : "true",
          WEB_AGENT_DEFAULT_LAUNCH_ARGS: hasDisplay()
            ? ""
            : "--disable-gpu,--disable-dev-shm-usage",
        },
        enabled: true,
        timeout: 60000,
      };
    }
  }

  if (toggles.pg_mcp !== false) {
    const serverRoot = resolveMcpServerRoot("pg-mcp");
    const pgConfigPath = join(serverRoot, "config.json");
    if (existsSync(pgConfigPath)) {
      result["pg-mcp"] = {
        type: "local",
        command: localCommand(join(serverRoot, "src", "index.js")),
        environment: {
          PG_MCP_CONFIG_PATH: pgConfigPath,
        },
        enabled: true,
        timeout: 60000,
      };
    }
  }

  if (toggles.ssh_mcp !== false) {
    const serverRoot = resolveMcpServerRoot("ssh-mcp");
    const sshConfigPath = join(serverRoot, "config.json");
    if (existsSync(sshConfigPath)) {
      result["ssh-mcp"] = {
        type: "local",
        command: localCommand(join(serverRoot, "src", "index.js")),
        environment: {
          SSH_MCP_CONFIG_PATH: sshConfigPath,
        },
        enabled: true,
        timeout: 60000,
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
      timeout: 60000,
    };
  }

  if (toggles.mariadb !== false) {
    result.mariadb = {
      type: "local",
      command: ["npx", "-y", "@cemalturkcann/mariadb-mcp-server"],
      enabled: true,
      timeout: 60000,
    };
  }

  return result;
}
