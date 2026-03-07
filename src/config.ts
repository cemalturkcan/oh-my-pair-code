import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { HarnessConfig } from "./types";
import { deepMerge } from "./utils";

const HarnessConfigSchema = z.object({
  default_mode: z.enum(["pair", "autonomous"]).optional(),
  set_default_agent: z.boolean().optional(),
  commands: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  credentials: z.object({
    jina_api_key: z.string().optional(),
  }).optional(),
  hooks: z.object({
    intent_gate: z.boolean().optional(),
    todo_continuation: z.boolean().optional(),
    comment_guard: z.boolean().optional(),
    todo_continuation_cooldown_ms: z.number().int().positive().optional(),
  }).optional(),
  mcps: z.object({
    context7: z.boolean().optional(),
    grep_app: z.boolean().optional(),
    websearch: z.boolean().optional(),
    chrome_devtools: z.boolean().optional(),
    pg_mcp: z.boolean().optional(),
    ssh_mcp: z.boolean().optional(),
    sudo_mcp: z.boolean().optional(),
    jina: z.boolean().optional(),
  }).optional(),
  agents: z.record(z.string(), z.object({
    model: z.string().optional(),
    variant: z.string().optional(),
    description: z.string().optional(),
    prompt_append: z.string().optional(),
  })).optional(),
});

const DEFAULTS: HarnessConfig = {
  default_mode: "pair",
  set_default_agent: true,
  commands: {
    enabled: true,
  },
  hooks: {
    intent_gate: true,
    todo_continuation: true,
    comment_guard: true,
    todo_continuation_cooldown_ms: 30000,
  },
  mcps: {
    context7: true,
    grep_app: true,
    websearch: true,
    chrome_devtools: true,
    pg_mcp: true,
    ssh_mcp: true,
    sudo_mcp: true,
    jina: true,
  },
  agents: {},
};

const ConfigSectionSchemas = {
  default_mode: HarnessConfigSchema.shape.default_mode,
  set_default_agent: HarnessConfigSchema.shape.set_default_agent,
  commands: HarnessConfigSchema.shape.commands,
  credentials: HarnessConfigSchema.shape.credentials,
  hooks: HarnessConfigSchema.shape.hooks,
  mcps: HarnessConfigSchema.shape.mcps,
  agents: HarnessConfigSchema.shape.agents,
} satisfies Record<keyof HarnessConfig, z.ZodTypeAny>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatParseErrors(errors: ParseError[]): string {
  return errors.map((error) => `offset ${error.offset}: code ${error.error}`).join(", ");
}

function logConfigWarning(filePath: string, message: string): void {
  console.warn(`[opencode-pair-autonomy] ${message} (${filePath})`);
}

function parseConfigPartially(parsed: unknown, filePath: string): HarnessConfig {
  if (!isRecord(parsed)) {
    logConfigWarning(filePath, "Ignoring config because it is not an object");
    return {};
  }

  const partial: Partial<HarnessConfig> = {};
  const invalidSections: string[] = [];

  for (const [key, schema] of Object.entries(ConfigSectionSchemas) as Array<[keyof HarnessConfig, z.ZodTypeAny]>) {
    if (!(key in parsed)) {
      continue;
    }

    const result = schema.safeParse(parsed[key]);
    if (result.success) {
      (partial as Record<string, unknown>)[key] = result.data;
      continue;
    }

    invalidSections.push(`${key}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  if (invalidSections.length > 0) {
    logConfigWarning(
      filePath,
      `Partially loaded config. Ignored invalid sections:\n- ${invalidSections.join("\n- ")}`,
    );
  }

  return partial;
}

function readConfigFile(filePath: string): HarnessConfig {
  if (!existsSync(filePath)) {
    return {};
  }

  const raw = readFileSync(filePath, "utf8");
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors);
  if (errors.length > 0) {
    logConfigWarning(filePath, `Ignoring unreadable JSONC config with parse errors: ${formatParseErrors(errors)}`);
    return {};
  }

  const result = HarnessConfigSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }

  return parseConfigPartially(parsed, filePath);
}

export function loadHarnessConfig(projectDirectory: string): HarnessConfig {
  const userPath = join(homedir(), ".config", "opencode", "opencode-pair-autonomy.jsonc");
  const projectPath = join(projectDirectory, ".opencode", "opencode-pair-autonomy.jsonc");

  return deepMerge(
    deepMerge(DEFAULTS, readConfigFile(userPath)),
    readConfigFile(projectPath),
  );
}

export const SAMPLE_PROJECT_CONFIG = `{
  // Project-level overrides for opencode-pair-autonomy
  "default_mode": "pair",
  "credentials": {
    "jina_api_key": ""
  },
  "hooks": {
    "intent_gate": true,
    "todo_continuation": true,
    "comment_guard": true,
    "todo_continuation_cooldown_ms": 30000
  },
  "mcps": {
    "context7": true,
    "grep_app": true,
    "websearch": true,
    "chrome_devtools": true,
    "pg_mcp": true,
    "ssh_mcp": true,
    "sudo_mcp": true,
    "jina": true
  },
  "agents": {
    "pair": {
      "variant": "high"
    },
    "autonomous": {
      "variant": "high"
    },
    "repo-scout-fast": {
      "model": "kimi-for-coding/k2p5"
    },
    "repo-scout-deep": {
      "model": "kimi-for-coding/kimi-k2-thinking"
    },
    "researcher-fast": {
      "model": "kimi-for-coding/k2p5"
    },
    "researcher-deep": {
      "model": "kimi-for-coding/kimi-k2-thinking"
    }
  }
}`;
