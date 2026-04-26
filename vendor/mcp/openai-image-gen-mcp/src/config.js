import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, "..", "config.json");
const DEFAULT_OUTPUT_DIR = join(homedir(), ".codex", "generated_images");

const DEFAULT_CONFIG = {
  default_model: "gpt-5.5-fast",
  default_reasoning_effort: "xhigh",
  default_instructions:
    "Bridge the JSON input to a single image_generation tool call and use source_prompt verbatim.",
  default_output_dir: DEFAULT_OUTPUT_DIR,
};

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveConfigPath() {
  return process.env.OPENAI_IMAGE_GEN_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH;
}

function resolveOutputDir(rawValue, configPath) {
  return expandPath(rawValue, configPath) || DEFAULT_CONFIG.default_output_dir;
}

function expandPath(value, configPath) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }

  if (normalized === "~") {
    return homedir();
  }

  if (normalized.startsWith("~/")) {
    return resolve(homedir(), normalized.slice(2));
  }

  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }

  return resolve(dirname(configPath), normalized);
}

export function loadConfig() {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return {
      ...DEFAULT_CONFIG,
      default_output_dir: resolveOutputDir(undefined, configPath),
      config_path: configPath,
    };
  }

  const raw = readFileSync(configPath, "utf8").trim();
  if (!raw) {
    return {
      ...DEFAULT_CONFIG,
      default_output_dir: resolveOutputDir(undefined, configPath),
      config_path: configPath,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse openai-image-gen-mcp config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`openai-image-gen-mcp config at ${configPath} must be a JSON object.`);
  }

  const default_model =
    normalizeNonEmptyString(parsed.default_model) || DEFAULT_CONFIG.default_model;
  const default_reasoning_effort =
    normalizeNonEmptyString(parsed.default_reasoning_effort) ||
    DEFAULT_CONFIG.default_reasoning_effort;
  const default_instructions =
    normalizeNonEmptyString(parsed.default_instructions) ||
    DEFAULT_CONFIG.default_instructions;
  const default_output_dir = resolveOutputDir(parsed.default_output_dir, configPath);

  return {
    config_path: configPath,
    default_model,
    default_reasoning_effort,
    default_instructions,
    default_output_dir,
  };
}
