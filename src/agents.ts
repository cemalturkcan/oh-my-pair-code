import type { AgentLike, HarnessConfig } from "./types";
import { buildArchitectPrompt, buildBuilderPrompt, buildRepairPrompt, buildRepoScoutPrompt, buildResearcherPrompt, buildVerifierPrompt } from "./prompts/subagents";
import { buildAutonomousPrompt } from "./prompts/autonomous";
import { buildPairDocsPrompt, buildPairPrompt } from "./prompts/pair";

function withOverride(base: AgentLike, override?: Record<string, unknown>): AgentLike {
  return {
    ...base,
    ...(override ?? {}),
  };
}

export function createHarnessAgents(config: HarnessConfig): Record<string, AgentLike> {
  const overrides = config.agents ?? {};

  return {
    build: withOverride({
      disable: true,
    }, overrides.build),
    plan: withOverride({
      disable: true,
    }, overrides.plan),
    pair: withOverride({
      mode: "primary",
      description: "Collaborative technical pair programmer.",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: buildPairPrompt(overrides.pair?.prompt_append),
    }, overrides.pair),
    "pair-docs": withOverride({
      mode: "primary",
      description: "Collaborative pair agent with full read access and Markdown-only edits.",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: buildPairDocsPrompt(overrides["pair-docs"]?.prompt_append),
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "allow",
        todoread: "allow",
        webfetch: "allow",
        websearch: "allow",
        codesearch: "allow",
        skill: "allow",
        edit: {
          "*": "deny",
          "*.md": "allow",
          "**/*.md": "allow",
        },
        bash: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        delegate: "deny",
      },
      tools: {
        task: false,
        delegate: false,
      },
    }, overrides["pair-docs"]),
    autonomous: withOverride({
      mode: "primary",
      description: "Checkpointed autonomous implementation agent.",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: buildAutonomousPrompt(overrides.autonomous?.prompt_append),
    }, overrides.autonomous),
    "repo-scout-fast": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Fast repository pattern scout.",
      model: "kimi-for-coding/k2p5",
      prompt: buildRepoScoutPrompt(overrides["repo-scout-fast"]?.prompt_append),
    }, overrides["repo-scout-fast"]),
    "repo-scout-deep": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Deep repository pattern scout.",
      model: "kimi-for-coding/kimi-k2-thinking",
      prompt: buildRepoScoutPrompt(overrides["repo-scout-deep"]?.prompt_append),
    }, overrides["repo-scout-deep"]),
    "researcher-fast": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Fast external researcher.",
      model: "kimi-for-coding/k2p5",
      prompt: buildResearcherPrompt(overrides["researcher-fast"]?.prompt_append),
    }, overrides["researcher-fast"]),
    "researcher-deep": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Deep external researcher.",
      model: "kimi-for-coding/kimi-k2-thinking",
      prompt: buildResearcherPrompt(overrides["researcher-deep"]?.prompt_append),
    }, overrides["researcher-deep"]),
    builder: withOverride({
      mode: "subagent",
      hidden: true,
      description: "Scoped implementation builder.",
      model: "openai/gpt-5.4",
      variant: "medium",
      prompt: buildBuilderPrompt(overrides.builder?.prompt_append),
    }, overrides.builder),
    "builder-deep": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Deep implementation builder.",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: buildBuilderPrompt(overrides["builder-deep"]?.prompt_append),
    }, overrides["builder-deep"]),
    "verifier-fast": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Fast verifier.",
      model: "kimi-for-coding/k2p5",
      prompt: buildVerifierPrompt(overrides["verifier-fast"]?.prompt_append),
    }, overrides["verifier-fast"]),
    verifier: withOverride({
      mode: "subagent",
      hidden: true,
      description: "Full verifier.",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: buildVerifierPrompt(overrides.verifier?.prompt_append),
    }, overrides.verifier),
    "repair-fast": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Fast scoped repair.",
      model: "openai/gpt-5.4",
      variant: "medium",
      prompt: buildRepairPrompt(overrides["repair-fast"]?.prompt_append),
    }, overrides["repair-fast"]),
    repair: withOverride({
      mode: "subagent",
      hidden: true,
      description: "Full scoped repair.",
      model: "openai/gpt-5.4",
      variant: "high",
      prompt: buildRepairPrompt(overrides.repair?.prompt_append),
    }, overrides.repair),
    "architect-fast": withOverride({
      mode: "subagent",
      hidden: true,
      description: "Fast implementation architect.",
      model: "openai/gpt-5.4",
      variant: "medium",
      prompt: buildArchitectPrompt(overrides["architect-fast"]?.prompt_append),
    }, overrides["architect-fast"]),
  };
}
