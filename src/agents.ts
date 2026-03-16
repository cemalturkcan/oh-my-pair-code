import type { AgentLike, HarnessConfig } from "./types";
import {
  buildAnotherEyePrompt,
  buildArchitectPrompt,
  buildBuildAnalyzerPrompt,
  buildBuilderPrompt,
  buildLearningExtractorPrompt,
  buildLoopOrchestratorPrompt,
  buildMemoryCuratorPrompt,
  buildRepairPrompt,
  buildRepoScoutPrompt,
  buildResearcherPrompt,
  buildVerifierPrompt,
} from "./prompts/subagents";
import { buildAutonomousPrompt } from "./prompts/autonomous";
import { buildPairPlanPrompt, buildPairPrompt } from "./prompts/pair";

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

export function createHarnessAgents(
  config: HarnessConfig,
): Record<string, AgentLike> {
  const overrides = config.agents ?? {};

  return {
    build: withOverride(
      {
        disable: true,
      },
      overrides.build,
    ),
    plan: withOverride(
      {
        disable: true,
      },
      overrides.plan,
    ),
    "pair-plan": withOverride(
      {
        mode: "primary",
        description:
          "Planning-first pair agent with full repo read access and Markdown-only writing.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildPairPlanPrompt(overrides["pair-plan"]?.prompt_append),
        tools: {
          read: true,
          write: true,
          edit: false,
          bash: true,
        },
        permission: {
          edit: "deny",
          bash: {
            "*": "deny",
            pwd: "allow",
            "ls*": "allow",
            "find *": "allow",
            "cat *": "allow",
            "head *": "allow",
            "tail *": "allow",
            "sed -n *": "allow",
            "rg *": "allow",
            "grep *": "allow",
            "wc *": "allow",
            "stat *": "allow",
            "file *": "allow",
            "git status*": "allow",
            "git diff*": "allow",
            "git log*": "allow",
            "git show*": "allow",
            "git branch*": "allow",
            "git rev-parse*": "allow",
            "git ls-files*": "allow",
            "git grep*": "allow",
            "git tag*": "allow",
            "git remote -v*": "allow",
            "git reflog*": "allow",
            "git blame*": "allow",
            "git shortlog*": "allow",
            "git describe*": "allow",
            "git --no-pager diff*": "allow",
            "git --no-pager log*": "allow",
            "git --no-pager show*": "allow",
            "git --no-pager grep*": "allow",
            "git --no-pager blame*": "allow",
            "git --no-pager shortlog*": "allow",
          },
          task: taskPermissions(
            "repo-scout-*",
            "researcher-*",
            "architect-fast",
          ),
        },
      },
      overrides["pair-plan"],
    ),
    pair: withOverride(
      {
        mode: "primary",
        description: "Collaborative technical pair programmer.",
        model: "anthropic/claude-opus-4-6",
        variant: "max",
        prompt: buildPairPrompt(overrides.pair?.prompt_append),
        permission: {
          task: taskPermissions(
            "repo-scout-*",
            "researcher-*",
            "builder*",
            "verifier*",
            "repair*",
            "architect-fast",
            "memory-curator",
            "learning-extractor",
            "build-analyzer",
            "loop-orchestrator",
            "another-eye",
          ),
        },
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
      },
      overrides.autonomous,
    ),
    "repo-scout-fast": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Fast repository pattern scout.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildRepoScoutPrompt(
          overrides["repo-scout-fast"]?.prompt_append,
        ),
      },
      overrides["repo-scout-fast"],
    ),
    "repo-scout-deep": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Deep repository pattern scout.",
        model: "anthropic/claude-sonnet-4-6-latest",
        prompt: buildRepoScoutPrompt(
          overrides["repo-scout-deep"]?.prompt_append,
        ),
      },
      overrides["repo-scout-deep"],
    ),
    "researcher-fast": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Fast external researcher.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildResearcherPrompt(
          overrides["researcher-fast"]?.prompt_append,
        ),
      },
      overrides["researcher-fast"],
    ),
    "researcher-deep": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Deep external researcher.",
        model: "anthropic/claude-sonnet-4-6-latest",
        prompt: buildResearcherPrompt(
          overrides["researcher-deep"]?.prompt_append,
        ),
      },
      overrides["researcher-deep"],
    ),
    builder: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Scoped implementation builder.",
        model: "anthropic/claude-sonnet-4-6-latest",
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
        variant: "high",
        prompt: buildBuilderPrompt(overrides["builder-deep"]?.prompt_append),
      },
      overrides["builder-deep"],
    ),
    "verifier-fast": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Fast verifier.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildVerifierPrompt(overrides["verifier-fast"]?.prompt_append),
      },
      overrides["verifier-fast"],
    ),
    verifier: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Full verifier.",
        model: "anthropic/claude-opus-4-6",
        variant: "high",
        prompt: buildVerifierPrompt(overrides.verifier?.prompt_append),
      },
      overrides.verifier,
    ),
    "repair-fast": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Fast scoped repair.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildRepairPrompt(overrides["repair-fast"]?.prompt_append),
      },
      overrides["repair-fast"],
    ),
    repair: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Full scoped repair.",
        model: "anthropic/claude-opus-4-6",
        variant: "high",
        prompt: buildRepairPrompt(overrides.repair?.prompt_append),
      },
      overrides.repair,
    ),
    "architect-fast": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Fast implementation architect.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildArchitectPrompt(
          overrides["architect-fast"]?.prompt_append,
        ),
      },
      overrides["architect-fast"],
    ),
    "memory-curator": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Session and project memory curator.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildMemoryCuratorPrompt(
          overrides["memory-curator"]?.prompt_append,
        ),
        tools: {
          read: true,
          write: false,
          edit: false,
          bash: false,
        },
      },
      overrides["memory-curator"],
    ),
    "learning-extractor": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Continuous-learning pattern extractor.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildLearningExtractorPrompt(
          overrides["learning-extractor"]?.prompt_append,
        ),
        tools: {
          read: true,
          write: false,
          edit: false,
          bash: false,
        },
      },
      overrides["learning-extractor"],
    ),
    "build-analyzer": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Long-output build and log analyzer.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildBuildAnalyzerPrompt(
          overrides["build-analyzer"]?.prompt_append,
        ),
        tools: {
          read: true,
          write: false,
          edit: false,
          bash: false,
        },
      },
      overrides["build-analyzer"],
    ),
    "loop-orchestrator": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Worktree, loop, and cascade orchestrator.",
        model: "anthropic/claude-haiku-4-5-latest",
        prompt: buildLoopOrchestratorPrompt(
          overrides["loop-orchestrator"]?.prompt_append,
        ),
        tools: {
          read: true,
          write: false,
          edit: false,
          bash: false,
        },
      },
      overrides["loop-orchestrator"],
    ),
    "another-eye": withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Cross-model second-opinion reviewer. Provides an independent perspective from a different AI model after implementation.",
        model: "openai/gpt-5.4",
        variant: "high",
        prompt: buildAnotherEyePrompt(overrides["another-eye"]?.prompt_append),
        tools: {
          read: true,
          write: false,
          edit: false,
          bash: true,
        },
        permission: {
          edit: "deny",
          write: "deny",
          bash: {
            "*": "deny",
            pwd: "allow",
            "ls*": "allow",
            "find *": "allow",
            "cat *": "allow",
            "head *": "allow",
            "tail *": "allow",
            "rg *": "allow",
            "grep *": "allow",
            "git status*": "allow",
            "git diff*": "allow",
            "git log*": "allow",
            "git show*": "allow",
            "git --no-pager diff*": "allow",
            "git --no-pager log*": "allow",
            "git --no-pager show*": "allow",
          },
        },
      },
      overrides["another-eye"],
    ),
  };
}
