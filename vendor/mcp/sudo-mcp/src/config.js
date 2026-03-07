import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

const configSchema = z.object({
  approval_ttl_seconds: z.coerce.number().int().min(15).max(3600).default(300),
  default_timeout_seconds: z.coerce.number().int().min(1).max(600).default(60),
  max_timeout_seconds: z.coerce.number().int().min(1).max(3600).default(300),
  max_output_bytes: z.coerce.number().int().min(1024).max(10_000_000).default(131072),
  require_non_interactive_sudo: z.boolean().default(true),
  require_allowlist: z.boolean().default(false),
  allow_patterns: z.array(z.string().min(1)).default([]),
  deny_patterns: z.array(z.string().min(1)).default([]),
});

function loadRawConfig() {
  const candidates = [
    process.env.SUDO_MCP_CONFIG_PATH,
    join(__dirname, "../config.json"),
    join(process.cwd(), "config.json"),
  ].filter(Boolean);

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;

    try {
      return {
        configPath,
        raw: JSON.parse(readFileSync(configPath, "utf8")),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read sudo-mcp config '${configPath}': ${message}`);
    }
  }

  throw new Error(
    "sudo-mcp config not found. Set SUDO_MCP_CONFIG_PATH or create config.json next to this server."
  );
}

export function loadConfig() {
  const { configPath, raw } = loadRawConfig();
  const parsed = configSchema.parse(raw);

  if (parsed.default_timeout_seconds > parsed.max_timeout_seconds) {
    throw new Error("default_timeout_seconds cannot be greater than max_timeout_seconds.");
  }

  return {
    configPath,
    ...parsed,
  };
}
