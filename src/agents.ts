import type { AgentLike, HarnessConfig } from "./types";
import { deepMerge } from "./utils";
import { buildCoordinatorPrompt } from "./prompts/coordinator";
import {
  buildEliotPrompt,
  buildTyrellPrompt,
  buildValidatorPrompt,
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

  return {
    mrrobot: withOverride(
      {
        mode: "primary",
        description:
          "MrRobot — Primary agent. Routes work, keeps scope tight, and answers plainly.",
        model: "openai/gpt-5.4-fast",
        variant: "high",
        prompt: buildCoordinatorPrompt(overrides.mrrobot?.prompt_append, config.mcps),
        color: "#4A90D9",
      },
      overrides.mrrobot,
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

    validator: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Validator — Validation-focused review and verification subagent.",
        model: "openai/gpt-5.4-fast",
        variant: "high",
        prompt: buildValidatorPrompt(overrides.validator?.prompt_append, config.mcps),
        temperature: 0.0,
        color: "#E67E22",
      },
      overrides.validator,
    ),

    build: { disable: true },
    plan: { disable: true },
  };
}
