import type { HarnessConfig } from "./types";

export function createHarnessCommands(
  config: HarnessConfig,
): Record<string, Record<string, unknown>> {
  if (config.commands?.enabled === false) {
    return {};
  }

  return {};
}
