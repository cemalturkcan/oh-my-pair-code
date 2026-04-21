import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "./types";

type McpConfig = Record<string, unknown>;

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
    const serverRoot = getManagedMcpRoot("web-agent-mcp");
    const serverEntry = join(serverRoot, "src", "server.ts");
    if (existsSync(serverEntry) && hasRequiredPackages("web-agent-mcp", serverRoot)) {
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
        timeout: 60000,
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
        timeout: 60000,
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
