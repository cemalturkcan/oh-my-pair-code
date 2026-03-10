import type { HarnessConfig } from "./types";

export function createHarnessCommands(config: HarnessConfig): Record<string, Record<string, unknown>> {
  if (config.commands?.enabled === false) {
    return {};
  }

  return {
    pair: {
      template: "{{args}}",
      description: "Run the request with the pair agent.",
      agent: "pair",
    },
    "pair-docs": {
      template: "{{args}}",
      description: "Run the request with the Markdown-only pair docs agent.",
      agent: "pair-docs",
    },
    autonomous: {
      template: "{{args}}",
      description: "Run the request with the autonomous agent.",
      agent: "autonomous",
    },
  };
}
