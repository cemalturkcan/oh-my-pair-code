import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHarnessMcps } from "../mcp";

function installPackageStub(root: string, packageName: string): void {
  mkdirSync(join(root, "node_modules", ...packageName.split("/")), {
    recursive: true,
  });
}

describe("createHarnessMcps", () => {
  let configHome: string;
  let oldConfigDir: string | undefined;
  let oldXdgConfigHome: string | undefined;
  let oldXdgDataHome: string | undefined;
  let oldDaemonToggle: string | undefined;

  beforeEach(() => {
    configHome = join(tmpdir(), `opencode-pair-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(configHome, { recursive: true });
    oldConfigDir = process.env.OPENCODE_CONFIG_DIR;
    oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
    oldXdgDataHome = process.env.XDG_DATA_HOME;
    oldDaemonToggle = process.env.OPENCODE_PAIR_WEB_AGENT_DAEMON;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = join(configHome, "data");
    process.env.OPENCODE_CONFIG_DIR = join(configHome, "opencode-test");
    delete process.env.OPENCODE_PAIR_WEB_AGENT_DAEMON;
  });

  afterEach(() => {
    if (oldConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = oldConfigDir;
    }

    if (oldXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = oldXdgConfigHome;
    }

    if (oldXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = oldXdgDataHome;
    }

    if (oldDaemonToggle === undefined) {
      delete process.env.OPENCODE_PAIR_WEB_AGENT_DAEMON;
    } else {
      process.env.OPENCODE_PAIR_WEB_AGENT_DAEMON = oldDaemonToggle;
    }

    rmSync(configHome, { recursive: true, force: true });
  });

  it("loads MCP servers from the shared MCP config root when deps exist", () => {
    const pgRoot = join(configHome, "pg-mcp");
    const sshRoot = join(configHome, "ssh-mcp");
    const webRoot = join(configHome, "web-agent-mcp");
    const imageRoot = join(configHome, "openai-image-gen-mcp");

    mkdirSync(join(pgRoot, "src"), { recursive: true });
    mkdirSync(join(sshRoot, "src"), { recursive: true });
    mkdirSync(join(webRoot, "src"), { recursive: true });
    mkdirSync(join(imageRoot, "src"), { recursive: true });
    writeFileSync(join(pgRoot, "src", "index.js"), "", "utf8");
    writeFileSync(join(sshRoot, "src", "index.js"), "", "utf8");
    writeFileSync(join(webRoot, "src", "server.ts"), "", "utf8");
    writeFileSync(join(imageRoot, "src", "index.js"), "", "utf8");
    writeFileSync(join(pgRoot, "config.json"), "{}", "utf8");
    writeFileSync(join(sshRoot, "config.json"), "{}", "utf8");
    writeFileSync(join(imageRoot, "config.json"), "{}", "utf8");
    installPackageStub(pgRoot, "@modelcontextprotocol/sdk");
    installPackageStub(pgRoot, "pg");
    installPackageStub(sshRoot, "@modelcontextprotocol/sdk");
    installPackageStub(sshRoot, "zod");
    installPackageStub(webRoot, "@modelcontextprotocol/sdk");
    installPackageStub(webRoot, "zod");
    installPackageStub(webRoot, "cloakbrowser");
    installPackageStub(webRoot, "playwright-core");
    installPackageStub(imageRoot, "@modelcontextprotocol/sdk");

    const mcps = createHarnessMcps({ agents: {}, mcps: {} });

    expect(mcps["pg-mcp"]).toMatchObject({
      command: ["node", join(pgRoot, "src", "index.js")],
      environment: {
        PG_MCP_CONFIG_PATH: join(pgRoot, "config.json"),
      },
    });
    expect(mcps["ssh-mcp"]).toMatchObject({
      command: ["node", join(sshRoot, "src", "index.js")],
      environment: {
        SSH_MCP_CONFIG_PATH: join(sshRoot, "config.json"),
      },
    });
    expect(mcps["web-agent-mcp"]).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:29741/mcp",
      oauth: false,
    });
    const controllerPath = join(configHome, "data", "opencode-pair", "web-agent", "controller.json");
    expect(existsSync(controllerPath)).toBe(true);
    expect(JSON.parse(readFileSync(controllerPath, "utf8"))).toMatchObject({
      endpoint: "http://127.0.0.1:29741/mcp",
    });
    expect(mcps["openai-image-gen-mcp"]).toMatchObject({
      command: ["node", join(imageRoot, "src", "index.js")],
      environment: {
        OPENAI_IMAGE_GEN_CONFIG_PATH: join(imageRoot, "config.json"),
      },
      timeout: 300000,
    });
  });

  it("preserves stdio web-agent fallback when daemon mode is disabled", () => {
    process.env.OPENCODE_PAIR_WEB_AGENT_DAEMON = "false";
    const webRoot = join(configHome, "web-agent-mcp");
    mkdirSync(join(webRoot, "src"), { recursive: true });
    writeFileSync(join(webRoot, "src", "server.ts"), "", "utf8");
    installPackageStub(webRoot, "@modelcontextprotocol/sdk");
    installPackageStub(webRoot, "zod");
    installPackageStub(webRoot, "cloakbrowser");
    installPackageStub(webRoot, "playwright-core");

    const mcps = createHarnessMcps({ agents: {}, mcps: {} });

    expect(mcps["web-agent-mcp"]).toMatchObject({
      type: "local",
      command: ["bun", "run", join(webRoot, "src", "server.ts")],
      environment: {
        WEB_AGENT_CHROME_USER_DATA_DIR: join(configHome, "data", "opencode-pair", "web-agent", "profile"),
      },
    });
  });

  it("registers openai-image-gen-mcp even when managed config.json is absent", () => {
    const imageRoot = join(configHome, "openai-image-gen-mcp");
    mkdirSync(join(imageRoot, "src"), { recursive: true });
    writeFileSync(join(imageRoot, "src", "index.js"), "", "utf8");
    installPackageStub(imageRoot, "@modelcontextprotocol/sdk");

    const mcps = createHarnessMcps({ agents: {}, mcps: {} });

    expect(mcps["openai-image-gen-mcp"]).toMatchObject({
      command: ["node", join(imageRoot, "src", "index.js")],
      environment: {
        OPENAI_IMAGE_GEN_CONFIG_PATH: join(imageRoot, "config.json"),
      },
      timeout: 300000,
    });
  });

  it("skips broken local MCP registrations when required deps are missing", () => {
    const pgRoot = join(configHome, "pg-mcp");
    mkdirSync(join(pgRoot, "src"), { recursive: true });
    writeFileSync(join(pgRoot, "src", "index.js"), "", "utf8");
    writeFileSync(join(pgRoot, "config.json"), "{}", "utf8");

    const mcps = createHarnessMcps({ agents: {}, mcps: {} });

    expect(mcps["pg-mcp"]).toBeUndefined();
  });
});
