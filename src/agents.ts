import type { AgentLike, HarnessConfig } from "./types";
import { deepMerge } from "./utils";
import { discoverInstalledSkills } from "./skills";
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
  const claudeOverride = deepMerge(overrides.michelangelo ?? {}, overrides.claude ?? {});
  const installedSkills = discoverInstalledSkills();

  return {
    mrrobot: withOverride(
      {
        mode: "primary",
        description:
          "MrRobot — Primary agent. Routes work, keeps scope tight, and answers plainly.",
        model: "openai/gpt-5.5-fast",
        variant: "xhigh",
        prompt: buildCoordinatorPrompt(
          overrides.mrrobot?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        color: "#4A90D9",
      },
      overrides.mrrobot,
    ),

    wick: withOverride(
      {
        mode: "primary",
        hidden: true,
        description:
          "Wick — Primary fast executor. Handles narrow, concrete tasks with minimal overhead.",
        model: "openai/gpt-5.5-fast",
        variant: "xhigh",
        prompt: buildWickPrompt(
          overrides.wick?.prompt_append,
          config.mcps,
          installedSkills,
        ),
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
        model: "openai/gpt-5.5-fast",
        variant: "xhigh",
        prompt: buildEliotPrompt(
          overrides.eliot?.prompt_append,
          config.mcps,
          installedSkills,
        ),
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
        model: "openai/gpt-5.5-fast",
        variant: "xhigh",
        prompt: buildTyrellPrompt(
          overrides.tyrell?.prompt_append,
          config.mcps,
          installedSkills,
        ),
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
        model: "openai/gpt-5.5-fast",
        variant: "xhigh",
        prompt: buildClaudePrompt(
          claudeOverride?.prompt_append,
          config.mcps,
          installedSkills,
        ),
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
        model: "openai/gpt-5.5-fast",
        variant: "xhigh",
        prompt: buildTuringPrompt(
          overrides.turing?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        temperature: 0.0,
        color: "#E67E22",
      },
      overrides.turing,
    ),

    build: { disable: true },
    plan: { disable: true },
  };
}
