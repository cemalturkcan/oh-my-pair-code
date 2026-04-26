import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installBundledSkills,
  mergePluginList,
  shouldPreserveFreshInstallEntry,
  syncManagedMcp,
  uninstallHarness,
} from "../installer";

describe("shouldPreserveFreshInstallEntry", () => {
  it("preserves the shared skills directory during fresh install cleanup", () => {
    const configDir = join(
      tmpdir(),
      `opencode-pair-installer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    mkdirSync(join(configDir, "skills"), { recursive: true });

    expect(shouldPreserveFreshInstallEntry(configDir, "skills")).toBe(true);

    rmSync(configDir, { recursive: true, force: true });
  });
});

describe("installBundledSkills", () => {
  it("refreshes managed bundled skills without overwriting unrelated user skills", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-skills");
    const skillsDir = join(root, "skills");

    mkdirSync(join(sourceRoot, "caveman"), { recursive: true });
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "version-1", "utf8");

    installBundledSkills(skillsDir, sourceRoot);
    expect(readFileSync(join(skillsDir, "caveman", "SKILL.md"), "utf8")).toBe("version-1");

    mkdirSync(join(skillsDir, "custom-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "custom-skill", "SKILL.md"), "custom", "utf8");
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "version-2", "utf8");

    installBundledSkills(skillsDir, sourceRoot);

    expect(readFileSync(join(skillsDir, "caveman", "SKILL.md"), "utf8")).toBe("version-2");
    expect(readFileSync(join(skillsDir, "custom-skill", "SKILL.md"), "utf8")).toBe("custom");

    rmSync(root, { recursive: true, force: true });
  });

  it("does not overwrite a pre-existing user skill that was never managed", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-user-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-skills");
    const skillsDir = join(root, "skills");

    mkdirSync(join(sourceRoot, "caveman"), { recursive: true });
    mkdirSync(join(skillsDir, "caveman"), { recursive: true });
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "managed", "utf8");
    writeFileSync(join(skillsDir, "caveman", "SKILL.md"), "user-owned", "utf8");

    installBundledSkills(skillsDir, sourceRoot);

    expect(readFileSync(join(skillsDir, "caveman", "SKILL.md"), "utf8")).toBe("user-owned");

    rmSync(root, { recursive: true, force: true });
  });

  it("removes previously managed skills that are no longer bundled", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-prune-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-skills");
    const skillsDir = join(root, "skills");

    mkdirSync(join(sourceRoot, "caveman"), { recursive: true });
    writeFileSync(join(sourceRoot, "caveman", "SKILL.md"), "managed", "utf8");
    installBundledSkills(skillsDir, sourceRoot);

    rmSync(join(sourceRoot, "caveman"), { recursive: true, force: true });
    installBundledSkills(skillsDir, sourceRoot);

    expect(existsSync(join(skillsDir, "caveman"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("mergePluginList", () => {
  it("adds the managed plugin entries and keeps unrelated custom plugins", () => {
    const merged = mergePluginList([
      "opencode-google-login@latest",
      "custom-plugin",
    ]);

    expect(merged).toContain("@tarquinen/opencode-dcp@latest");
    expect(merged).toContain("opencode-pty@latest");
    expect(merged.some((item) => item.startsWith("opencode-google-login"))).toBe(false);
    expect(merged).toContain("custom-plugin");
  });

  it("drops stale managed plugin specs before writing the current managed set", () => {
    const merged = mergePluginList([
      "@tarquinen/opencode-dcp@3.1.0",
      "opencode-pty@1.2.3",
      "@zenobius/opencode-skillful@2.0.0",
      "custom-plugin",
    ]);

    expect(merged.filter((item) => item.startsWith("@tarquinen/opencode-dcp")).sort()).toEqual([
      "@tarquinen/opencode-dcp@latest",
    ]);
    expect(merged.filter((item) => item.startsWith("opencode-pty")).sort()).toEqual([
      "opencode-pty@latest",
    ]);
    expect(
      merged.filter((item) => item.startsWith("@zenobius/opencode-skillful")).sort(),
    ).toEqual(["@zenobius/opencode-skillful@latest"]);
    expect(merged).toContain("custom-plugin");
  });

  it("keeps unrelated local file plugins during install merging", () => {
    const merged = mergePluginList([
      "file:///tmp/custom-local-plugin",
      "opencode-pty@1.2.3",
    ]);

    expect(merged).toContain("file:///tmp/custom-local-plugin");
    expect(merged.filter((item) => item.startsWith("opencode-pty")).sort()).toEqual([
      "opencode-pty@latest",
    ]);
  });
});

describe("uninstallHarness", () => {
  it("prunes stale local harness plugin targets during uninstall", async () => {
    const root = join(
      tmpdir(),
      `opencode-pair-uninstall-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;

    mkdirSync(join(root, "vendor", "opencode-background-agents-local"), { recursive: true });
    writeFileSync(
      join(root, "opencode.json"),
      JSON.stringify(
        {
          plugin: [
            "file:///tmp/opencode-background-agents-local",
            "opencode-google-login@latest",
            "opencode-pty@latest",
            "custom-plugin",
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    process.env.OPENCODE_CONFIG_DIR = root;

    try {
      await uninstallHarness();
      const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
        plugin?: string[];
      };

      expect(config.plugin).toEqual(["custom-plugin"]);
      expect(existsSync(join(root, "vendor", "opencode-background-agents-local"))).toBe(false);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.OPENCODE_CONFIG_DIR;
      } else {
        process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("syncManagedMcp", () => {
  it("refreshes managed web-agent-mcp deps on source changes and preserves config", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-mcp");
    const targetRoot = join(root, "target-mcp");

    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "server.ts"), "v1", "utf8");
    writeFileSync(join(sourceRoot, "package.json"), "{}", "utf8");
    mkdirSync(join(targetRoot, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "stale", "utf8");
    writeFileSync(join(targetRoot, "config.json"), '{"keep":true}', "utf8");

    syncManagedMcp("web-agent-mcp", sourceRoot, targetRoot);
    expect(readFileSync(join(targetRoot, "config.json"), "utf8")).toBe('{"keep":true}');
    expect(() => readFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "utf8")).toThrow();

    mkdirSync(join(targetRoot, "node_modules", "leftpad"), { recursive: true });
    writeFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "fresh", "utf8");
    syncManagedMcp("web-agent-mcp", sourceRoot, targetRoot);
    expect(readFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "utf8")).toBe("fresh");

    writeFileSync(join(sourceRoot, "src", "server.ts"), "v2", "utf8");
    syncManagedMcp("web-agent-mcp", sourceRoot, targetRoot);
    expect(() => readFileSync(join(targetRoot, "node_modules", "leftpad", "index.js"), "utf8")).toThrow();
    expect(readFileSync(join(targetRoot, "config.json"), "utf8")).toBe('{"keep":true}');

    rmSync(root, { recursive: true, force: true });
  });

  it("migrates known old image MCP model defaults without clobbering other config", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-image-mcp-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-mcp");
    const targetRoot = join(root, "target-mcp");

    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "package.json"), "{}", "utf8");
    writeFileSync(
      join(sourceRoot, "config.json"),
      JSON.stringify({ default_model: "gpt-5.5-fast", custom: "source" }),
      "utf8",
    );
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(
      join(targetRoot, "config.json"),
      JSON.stringify({ default_model: "gpt-5.4", default_reasoning_effort: "high", custom: "user" }),
      "utf8",
    );

    syncManagedMcp("openai-image-gen-mcp", sourceRoot, targetRoot);

    expect(JSON.parse(readFileSync(join(targetRoot, "config.json"), "utf8"))).toEqual({
      default_model: "gpt-5.5-fast",
      default_reasoning_effort: "xhigh",
      custom: "user",
    });

    rmSync(root, { recursive: true, force: true });
  });

  it("prunes previously managed MCP paths that disappear from the bundled source", () => {
    const root = join(
      tmpdir(),
      `opencode-pair-mcp-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const sourceRoot = join(root, "source-mcp");
    const targetRoot = join(root, "target-mcp");

    mkdirSync(join(sourceRoot, "src", "lib"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", "server.ts"), "server", "utf8");
    writeFileSync(join(sourceRoot, "src", "lib", "old.ts"), "old", "utf8");
    writeFileSync(join(sourceRoot, "config.json"), '{"source":true}', "utf8");

    syncManagedMcp("pg-mcp", sourceRoot, targetRoot);
    writeFileSync(join(targetRoot, "config.json"), '{"keep":true}', "utf8");

    rmSync(join(sourceRoot, "src", "lib", "old.ts"), { force: true });
    syncManagedMcp("pg-mcp", sourceRoot, targetRoot);

    expect(existsSync(join(targetRoot, "src", "lib", "old.ts"))).toBe(false);
    expect(readFileSync(join(targetRoot, "config.json"), "utf8")).toBe('{"keep":true}');

    rmSync(root, { recursive: true, force: true });
  });
});
