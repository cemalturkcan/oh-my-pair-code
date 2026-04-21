import type { AgentLike, HarnessConfig } from "./types";
import { deepMerge } from "./utils";
import { buildCoordinatorPrompt, buildWickPrompt } from "./prompts/coordinator";
import {
  buildEliotPrompt,
  buildClaudePrompt,
  buildTuringPrompt,
  buildTyrellPrompt,
} from "./prompts/workers";

function withOverride(
  base: AgentLike,
  override?: Record<string, unknown>,
): AgentLike {
  if (!override) return base;
  return deepMerge(base, override);
}

export function createHarnessAgents(
  config: HarnessConfig,
): Record<string, AgentLike> {
  const overrides = config.agents ?? {};
  const claudeOverride = deepMerge(
    overrides.michelangelo ?? {},
    overrides.claude ?? {},
  );

  return {
    mrrobot: withOverride(
      {
        mode: "primary",
        description:
          "MrRobot — Primary agent. Routes work, keeps scope tight, and answers plainly.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildCoordinatorPrompt(overrides.mrrobot?.prompt_append, config.mcps),
        color: "#4A90D9",
      },
      overrides.mrrobot,
    ),

    wick: withOverride(
      {
        mode: "primary",
        description:
          "Wick — Primary fast executor. Handles narrow, concrete tasks with minimal overhead.",
        model: "openai/gpt-5.4-mini",
        variant: "low",
        prompt: buildWickPrompt(overrides.wick?.prompt_append, config.mcps),
        temperature: 0.0,
        color: "#C0392B",
      },
      overrides.wick,
    ),

    eliot: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Eliot — General-purpose subagent for implementation and repo work.",
        model: "openai/gpt-5.4-fast",
        variant: "high",
        prompt: buildEliotPrompt(overrides.eliot?.prompt_append, config.mcps),
        temperature: 0.2,
        color: "#2ECC71",
      },
      overrides.eliot,
    ),

    tyrell: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Tyrell — Ideation subagent for creative options, naming, UX direction, and product ideas.",
        model: "openai/gpt-5.4-fast",
        variant: "high",
        prompt: buildTyrellPrompt(overrides.tyrell?.prompt_append, config.mcps),
        temperature: 0.7,
        color: "#9B59B6",
      },
      overrides.tyrell,
    ),

    claude: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Claude — Frontend design subagent for UI layout, styling, and visual polish.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildClaudePrompt(claudeOverride?.prompt_append, config.mcps),
        temperature: 0.4,
        color: "#D35400",
      },
      claudeOverride,
    ),

    michelangelo: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description:
          "Claude — Deprecated michelangelo alias for the frontend design subagent.",
        model: "openai/gpt-5.4",
        variant: "xhigh",
        prompt: buildClaudePrompt(claudeOverride?.prompt_append, config.mcps),
        temperature: 0.4,
        color: "#D35400",
      },
      claudeOverride,
    ),

    turing: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Turing — Validation-focused review and verification subagent.",
        model: "openai/gpt-5.4-fast",
        variant: "high",
        prompt: buildTuringPrompt(overrides.turing?.prompt_append, config.mcps),
        temperature: 0.0,
        color: "#E67E22",
      },
      overrides.turing,
    ),

    build: { disable: true },
    plan: { disable: true },
  };
}
