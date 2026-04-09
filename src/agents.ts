import type { AgentLike, HarnessConfig, McpToggles } from "./types";
import { deepMerge } from "./utils";
import { buildCoordinatorPrompt } from "./prompts/coordinator";
import { buildDenyRules } from "./prompts/mcp-access";
import {
  buildWorkerPrompt,
  buildResearcherPrompt,
  buildReviewerPrompt,
  buildVerifierPrompt,
  buildRepairPrompt,
  buildUiDeveloperPrompt,
  buildRepoScoutPrompt,
} from "./prompts/workers";

function withOverride(
  base: AgentLike,
  override?: Record<string, unknown>,
): AgentLike {
  if (!override) return base;
  return deepMerge(base, override);
}

function taskPermissions(...allowedPatterns: string[]) {
  const permissions: Record<string, string> = { "*": "deny" };
  for (const pattern of allowedPatterns) {
    permissions[pattern] = "allow";
  }
  return permissions;
}

const COORDINATOR_TASK_PERMISSIONS = taskPermissions(
  "thorfinn",
  "ginko",
  "rust",
  "spock",
  "geralt",
  "edward",
  "killua",
);

// Only the expensive MCPs are disabled on the coordinator (~30k token savings).
// Lighter MCPs stay open so the coordinator can use them directly.
const COORDINATOR_DISABLED_TOOLS = buildDenyRules("yang");

export function createHarnessAgents(
  config: HarnessConfig,
): Record<string, AgentLike> {
  const overrides = config.agents ?? {};

  return {
    // ── Coordinator (primary agent) ──────────────────────────────
    yang: withOverride(
      {
        mode: "primary",
        description:
          "Yang Wenli — Senior technical lead. Plans, argues, delegates, synthesizes.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildCoordinatorPrompt(overrides.yang?.prompt_append, config.mcps),
        color: "#4A90D9",
        tools: COORDINATOR_DISABLED_TOOLS,
        permission: { task: COORDINATOR_TASK_PERMISSIONS },
      },
      overrides.yang,
    ),

    // ── Workers (subagents) ──────────────────────────────────────
    thorfinn: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Thorfinn — General purpose implementation worker.",
        model: "openai/gpt-5.3-codex-spark",
        variant: "high",
        prompt: buildWorkerPrompt(overrides.thorfinn?.prompt_append, config.mcps),
        temperature: 0.2,
        color: "#2ECC71",
        tools: buildDenyRules("thorfinn"),
      },
      overrides.thorfinn,
    ),

    ginko: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Ginko — Web and doc researcher.",
        model: "openai/gpt-5.4",
        variant: "medium",
        prompt: buildResearcherPrompt(overrides.ginko?.prompt_append, config.mcps),
        temperature: 0.3,
        color: "#F39C12",
        tools: buildDenyRules("ginko"),
        permission: {
          edit: "deny",
          write: "deny",
        },
      },
      overrides.ginko,
    ),

    rust: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Rust Cohle — Senior code reviewer. Finds subtle bugs and security issues.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildReviewerPrompt(overrides.rust?.prompt_append, config.mcps),
        temperature: 0.1,
        color: "#E74C3C",
        tools: buildDenyRules("rust"),
        permission: {
          edit: "deny",
          write: "deny",
        },
      },
      overrides.rust,
    ),

    spock: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Spock — Build, test, lint verifier.",
        model: "openai/gpt-5.4",
        variant: "medium",
        prompt: buildVerifierPrompt(overrides.spock?.prompt_append, config.mcps),
        temperature: 0.0,
        color: "#95A5A6",
        tools: buildDenyRules("spock"),
      },
      overrides.spock,
    ),

    geralt: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Geralt — Scoped failure repair agent.",
        model: "openai/gpt-5.3-codex-spark",
        variant: "medium",
        prompt: buildRepairPrompt(overrides.geralt?.prompt_append, config.mcps),
        temperature: 0.1,
        color: "#E67E22",
        tools: buildDenyRules("geralt"),
      },
      overrides.geralt,
    ),

    edward: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Edward — Frontend specialist with browser automation.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildUiDeveloperPrompt(overrides.edward?.prompt_append, config.mcps),
        temperature: 0.5,
        color: "#FF69B4",
        tools: buildDenyRules("edward"),
      },
      overrides.edward,
    ),

    killua: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Killua — Fast codebase explorer.",
        model: "openai/gpt-5.4",
        variant: "medium",
        prompt: buildRepoScoutPrompt(overrides.killua?.prompt_append, config.mcps),
        temperature: 0.1,
        color: "#1ABC9C",
        tools: buildDenyRules("killua"),
        permission: {
          edit: "deny",
          write: "deny",
        },
      },
      overrides.killua,
    ),

    // ── Disable OpenCode built-in agents ─────────────────────────
    build: { disable: true },
    plan: { disable: true },
  };
}
