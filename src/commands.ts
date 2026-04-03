import type { HarnessConfig } from "./types";

export function createHarnessCommands(
  config: HarnessConfig,
): Record<string, Record<string, unknown>> {
  if (config.commands?.enabled === false) {
    return {};
  }

  return {
    go: {
      template: "[harness:mode:executing] $ARGUMENTS",
      description: "Exit plan mode and start execution.",
      agent: "yang",
    },
    plan: {
      template: "[harness:mode:planning] $ARGUMENTS",
      description: "Return to plan mode.",
      agent: "yang",
    },
    "create-skill": {
      template:
        "Analyze the current session learnings and create a reusable skill from them. Save to ~/.config/opencode/skills/. $ARGUMENTS",
      description: "Create a skill from session learnings.",
      agent: "yang",
    },
  };
}
