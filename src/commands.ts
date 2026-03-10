import type { HarnessConfig } from "./types";

export function createHarnessCommands(config: HarnessConfig): Record<string, Record<string, unknown>> {
  if (config.commands?.enabled === false) {
    return {};
  }

  return {
    "pair-plan": {
      template: "{{args}}",
      description: "Run the request with the planning-first pair agent.",
      agent: "pair-plan",
    },
    pair: {
      template: "{{args}}",
      description: "Run the request with the pair agent.",
      agent: "pair",
    },
    autonomous: {
      template: "{{args}}",
      description: "Run the request with the autonomous agent.",
      agent: "autonomous",
    },
  };
}
