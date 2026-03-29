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
    autonomous: {
      template: "{{args}}",
      description: "Run the request with the autonomous agent.",
      agent: "autonomous",
    },
    review: {
      template: "{{args}}",
      description: "Run a code review with the reviewer agent.",
      agent: "reviewer",
    },
    search: {
      template: "{{args}}",
      description: "Run a web research task with the web-search agent.",
      agent: "web-search",
    },
    ui: {
      template: "{{args}}",
      description: "Run a UI/design task with the ui-developer agent.",
      agent: "ui-developer",
    },
    verify: {
      template: "Run a focused verification pass for the current work and report the first meaningful failures or confirmation of success. {{args}}",
      description: "Run a focused verifier pass.",
      agent: "verifier",
      subtask: true,
    },
  };
}
