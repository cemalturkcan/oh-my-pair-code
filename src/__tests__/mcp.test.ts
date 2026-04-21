import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  beforeEach(() => {
    configHome = join(tmpdir(), `opencode-pair-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(configHome, { recursive: true });
    oldConfigDir = process.env.OPENCODE_CONFIG_DIR;
    oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.OPENCODE_CONFIG_DIR = join(configHome, "opencode-test");
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

    rmSync(configHome, { recursive: true, force: true });
  });

  it("loads local MCP servers from the shared MCP config root when deps exist", () => {
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
      command: ["bun", "run", join(webRoot, "src", "server.ts")],
    });
    expect(mcps["openai-image-gen-mcp"]).toMatchObject({
      command: ["node", join(imageRoot, "src", "index.js")],
      environment: {
        OPENAI_IMAGE_GEN_CONFIG_PATH: join(imageRoot, "config.json"),
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
