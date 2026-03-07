import type { Plugin } from "@opencode-ai/plugin";
import { loadHarnessConfig } from "./config";
import { createHarnessAgents } from "./agents";
import { createHarnessMcps } from "./mcp";
import { createHarnessCommands } from "./commands";
import { createHarnessHooks } from "./hooks";

const PairAutonomyPlugin: Plugin = async (ctx) => {
  const harnessConfig = loadHarnessConfig(ctx.directory);
  const hooks = createHarnessHooks(ctx, harnessConfig);

  return {
    config: async (config) => {
      const mutableConfig = config as unknown as Record<string, unknown>;
      const existingAgents = (mutableConfig.agent ?? {}) as Record<string, unknown>;
      const existingMcps = (mutableConfig.mcp ?? {}) as Record<string, unknown>;
      const existingCommands = (mutableConfig.command ?? {}) as Record<string, unknown>;
      const harnessAgents = createHarnessAgents(harnessConfig);
      const harnessMcps = createHarnessMcps(harnessConfig);
      const harnessCommands = createHarnessCommands(harnessConfig);

      mutableConfig.agent = {
        ...existingAgents,
        ...harnessAgents,
      };

      mutableConfig.mcp = {
        ...existingMcps,
        ...harnessMcps,
      };

      mutableConfig.command = {
        ...harnessCommands,
        ...existingCommands,
      };

      if (harnessConfig.set_default_agent !== false) {
        mutableConfig.default_agent = harnessConfig.default_mode === "autonomous"
          ? "autonomous"
          : "pair";
      }
    },
    ...(hooks["chat.message"] ? { "chat.message": hooks["chat.message"] } : {}),
    ...(hooks.event ? { event: hooks.event } : {}),
    ...(hooks["tool.execute.after"] ? { "tool.execute.after": hooks["tool.execute.after"] } : {}),
  };
};

export default PairAutonomyPlugin;
