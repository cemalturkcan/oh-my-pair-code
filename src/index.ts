import type { Plugin as OpencodePlugin } from "@opencode-ai/plugin";
import { loadHarnessConfig } from "./config";
import { createHarnessAgents } from "./agents";
import { createHarnessMcps } from "./mcp";
import { createHarnessCommands } from "./commands";
import { createHarnessHooks } from "./hooks";
import { createOrchestratorLedger } from "./orchestrator/ledger";
import { createOrchestrationTools } from "./orchestrator/tools";
import { PRIMARY_AGENT } from "./orchestrator/constants";

const PairAutonomyPlugin: OpencodePlugin = async (ctx) => {
  const harnessConfig = loadHarnessConfig(ctx.directory);
  const ledger = createOrchestratorLedger(ctx.directory, harnessConfig);
  const hooks = await createHarnessHooks(ctx, harnessConfig, ledger);

  return {
    config: async (config) => {
      const mutableConfig = config as unknown as Record<string, unknown>;
      const existingAgents = (mutableConfig.agent ?? {}) as Record<
        string,
        unknown
      >;
      const existingMcps = (mutableConfig.mcp ?? {}) as Record<string, unknown>;
      const existingCommands = (mutableConfig.command ?? {}) as Record<
        string,
        unknown
      >;
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
        mutableConfig.default_agent = PRIMARY_AGENT;
      }

      await hooks.config?.(config);
    },
    tool: createOrchestrationTools(ledger, harnessConfig, ctx.directory),
    ...(hooks["chat.message"] ? { "chat.message": hooks["chat.message"] } : {}),
    ...(hooks.event ? { event: hooks.event } : {}),
    ...(hooks["tool.execute.before"]
      ? { "tool.execute.before": hooks["tool.execute.before"] }
      : {}),
    ...(hooks["tool.execute.after"]
      ? { "tool.execute.after": hooks["tool.execute.after"] }
      : {}),
    ...(hooks["session.deleted"]
      ? { "session.deleted": hooks["session.deleted"] }
      : {}),
    ...(hooks["experimental.session.compacting"]
      ? { "experimental.session.compacting": hooks["experimental.session.compacting"] }
      : {}),
  };
};

export const server = PairAutonomyPlugin;
export const Plugin = PairAutonomyPlugin;
export default PairAutonomyPlugin;
