import type { Plugin } from "@opencode-ai/plugin";
import { loadHarnessConfig } from "./config";
import { createHarnessAgents } from "./agents";
import { createHarnessMcps } from "./mcp";
import { createHarnessCommands } from "./commands";
import { createHarnessHooks } from "./hooks";
import { createAnthropicOAuth } from "./anthropic/oauth";

const PairAutonomyPlugin: Plugin = async (ctx) => {
  const harnessConfig = loadHarnessConfig(ctx.directory);
  const hooks = await createHarnessHooks(ctx, harnessConfig);
  const oauth =
    harnessConfig.hooks?.anthropic_oauth !== false
      ? await createAnthropicOAuth(ctx.client)
      : null;

  return {
    ...(oauth ? { auth: oauth.auth } : {}),
    ...(oauth
      ? {
          "experimental.chat.system.transform": async (
            input: any,
            output: any,
          ) => {
            oauth.systemTransform(input, output);
          },
        }
      : {}),
    ...(hooks["experimental.chat.messages.transform"]
      ? {
          "experimental.chat.messages.transform":
            hooks["experimental.chat.messages.transform"],
        }
      : {}),
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
        mutableConfig.default_agent =
          harnessConfig.default_mode === "autonomous"
            ? "autonomous"
            : harnessConfig.default_mode === "pair-plan"
              ? "pair-plan"
              : "pair";
      }

      await hooks.config?.(config);
    },
    ...(hooks["chat.message"] ? { "chat.message": hooks["chat.message"] } : {}),
    ...(hooks.event ? { event: hooks.event } : {}),
    ...(hooks["tool.execute.before"]
      ? { "tool.execute.before": hooks["tool.execute.before"] }
      : {}),
    ...(hooks["tool.execute.after"]
      ? { "tool.execute.after": hooks["tool.execute.after"] }
      : {}),
    ...(hooks["file.edited"] ? { "file.edited": hooks["file.edited"] } : {}),
    ...(hooks["session.created"]
      ? { "session.created": hooks["session.created"] }
      : {}),
    ...(hooks["session.idle"] ? { "session.idle": hooks["session.idle"] } : {}),
    ...(hooks["session.deleted"]
      ? { "session.deleted": hooks["session.deleted"] }
      : {}),
    ...(hooks["experimental.session.compacting"]
      ? {
          "experimental.session.compacting":
            hooks["experimental.session.compacting"],
        }
      : {}),
    ...(hooks["experimental.text.complete"]
      ? { "experimental.text.complete": hooks["experimental.text.complete"] }
      : {}),
  };
};

export default PairAutonomyPlugin;
