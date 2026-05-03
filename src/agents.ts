import type { AgentLike, HarnessConfig } from "./types";
import { deepMerge } from "./utils";
import { discoverInstalledSkills } from "./skills";
import { buildCoordinatorPrompt } from "./prompts/coordinator";
import {
  buildEliotPrompt,
  buildClaudePrompt,
  buildTuringPrompt,
  buildTyrellPrompt,
} from "./prompts/workers";

const DEFAULT_MODEL = "openai/gpt-5.5-fast";

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
    (overrides.michelangelo ?? {}) as Record<string, unknown>,
    (overrides.claude ?? {}) as Record<string, unknown>,
  );
  const installedSkills = discoverInstalledSkills();

  return {
    mrrobot: withOverride(
      {
        mode: "primary",
        description:
          "MrRobot — Primary agent. Routes work, keeps scope tight, and answers plainly.",
        model: DEFAULT_MODEL,
        variant: "medium",
        prompt: buildCoordinatorPrompt(
          overrides.mrrobot?.prompt_append,
          config.mcps,
          installedSkills,
        ),
        color: "#4A90D9",
      },
      overrides.mrrobot,
    ),

    eliot: withOverride(
      {
        mode: "subagent",
        hidden: true,
        description: "Eliot — General-purpose subagent for implementation and repo work.",
        model: DEFAULT_MODEL,
        variant: "low",
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
        model: DEFAULT_MODEL,
        variant: "low",
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
        model: DEFAULT_MODEL,
        variant: "low",
        prompt: buildClaudePrompt(
          typeof claudeOverride.prompt_append === "string"
            ? claudeOverride.prompt_append
            : undefined,
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
        model: DEFAULT_MODEL,
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
