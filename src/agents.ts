import type { AgentLike, HarnessConfig } from "./types";
import {
  buildBuilderPrompt,
  buildRepairPrompt,
  buildRepoScoutPrompt,
  buildResearcherPrompt,
  buildVerifierPrompt,
  buildYetAnotherReviewerPrompt,
} from "./prompts/subagents";
import { buildAutonomousPrompt } from "./prompts/autonomous";
import { buildPairPrompt } from "./prompts/pair";
import { buildReviewerPrompt } from "./prompts/reviewer";
import { buildUiDeveloperPrompt } from "./prompts/ui-developer";
import { buildWebSearchPrompt } from "./prompts/web-search";

function withOverride(
  base: AgentLike,
  override?: Record<string, unknown>,
): AgentLike {
  return {
    ...base,
    ...(override ?? {}),
  };
}

function taskPermissions(...allowedPatterns: string[]) {
  const permissions: Record<string, string> = { "*": "deny" };
  for (const pattern of allowedPatterns) {
    permissions[pattern] = "allow";
  }
  return permissions;
}

const PRIMARY_TASK_PERMISSIONS = taskPermissions(
  "repo-scout",
  "researcher",
  "builder*",
  "verifier",
  "repair",
  "reviewer",
  "yet-another-reviewer",
  "web-search",
  "ui-developer",
);

export function createHarnessAgents(
  config: HarnessConfig,
): Record<string, AgentLike> {
  const overrides = config.agents ?? {};

  return {
    // ── Primary agents (tab-switchable, all Opus max) ──────────────
    pair: withOverride(
      {
        mode: "primary",
        description: "Collaborative technical pair programmer.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildPairPrompt(overrides.pair?.prompt_append),
        permission: { task: PRIMARY_TASK_PERMISSIONS },
      },
      overrides.pair,
    ),
    autonomous: withOverride(
      {
        mode: "primary",
        description: "Checkpointed autonomous implementation agent.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildAutonomousPrompt(overrides.autonomous?.prompt_append),
        permission: { task: PRIMARY_TASK_PERMISSIONS },
      },
      overrides.autonomous,
    ),
    reviewer: withOverride(
      {
        mode: "primary",
        description: "Primary code reviewer with cross-model delegation.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildReviewerPrompt(overrides.reviewer?.prompt_append),
        permission: {
          task: taskPermissions("yet-another-reviewer", "repo-scout"),
        },
      },
      overrides.reviewer,
    ),
    "web-search": withOverride(
      {
        mode: "primary",
        description: "Web research agent with full MCP access.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildWebSearchPrompt(overrides["web-search"]?.prompt_append),
        permission: {
          task: taskPermissions("repo-scout", "researcher"),
        },
      },
      overrides["web-search"],
    ),
    "ui-developer": withOverride(
      {
        mode: "primary",
        description:
          "UI developer and design craftsman with Figma extraction and live review.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildUiDeveloperPrompt(
          overrides["ui-developer"]?.prompt_append,
        ),
        permission: {
          task: taskPermissions("repo-scout", "builder*", "verifier", "repair"),
        },
      },
      overrides["ui-developer"],
    ),

    // ── Subagents ──────────────────────────────────────────────────
    "repo-scout": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Repository pattern scout.",
        model: "anthropic/claude-sonnet-4-6",
        variant: "max",
        prompt: buildRepoScoutPrompt(overrides["repo-scout"]?.prompt_append),
      },
      overrides["repo-scout"],
    ),
    researcher: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "External docs and library researcher.",
        model: "anthropic/claude-sonnet-4-6",
        variant: "max",
        prompt: buildResearcherPrompt(overrides.researcher?.prompt_append),
      },
      overrides.researcher,
    ),
    builder: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Scoped implementation builder.",
        model: "anthropic/claude-sonnet-4-6",
        variant: "max",
        prompt: buildBuilderPrompt(overrides.builder?.prompt_append),
      },
      overrides.builder,
    ),
    "builder-deep": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Deep implementation builder.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildBuilderPrompt(overrides["builder-deep"]?.prompt_append),
      },
      overrides["builder-deep"],
    ),
    verifier: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Verifier and failure classifier.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildVerifierPrompt(overrides.verifier?.prompt_append),
      },
      overrides.verifier,
    ),
    repair: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Scoped repair agent.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildRepairPrompt(overrides.repair?.prompt_append),
      },
      overrides.repair,
    ),
    "yet-another-reviewer": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Cross-model independent reviewer. Provides a different AI perspective for review diversity.",
        model: "openai/gpt-5.4",
        variant: "max",
        prompt: buildYetAnotherReviewerPrompt(
          overrides["yet-another-reviewer"]?.prompt_append,
        ),
      },
      overrides["yet-another-reviewer"],
    ),

    // ── Disable OpenCode built-in agents ─────────────────────────
    build: { disable: true },
    plan: { disable: true },
  };
}
