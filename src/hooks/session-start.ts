import type { PluginInput } from "@opencode-ai/plugin";
import { detectLocaleFromTexts, extractTextParts } from "../i18n";
import type { HarnessConfig } from "../types";
import type { HookRuntime } from "./runtime";
import { PRIMARY_AGENTS, resolveSessionOrEntityID } from "./runtime";

type ChatMessageInput = {
  sessionID: string;
  agent?: string;
};

type ChatMessageOutput = {
  message: Record<string, unknown>;
  parts?: Array<{ type?: string; text?: string }>;
};

export function createSessionStartHook(
  _ctx: PluginInput,
  config: HarnessConfig,
  runtime: HookRuntime,
) {
  return {
    "session.created": async (input?: unknown): Promise<void> => {
      if (
        config.memory?.enabled === false &&
        config.learning?.enabled === false
      ) {
        return;
      }

      // session.created input IS the session object, so bare .id is safe
      const sessionID = resolveSessionOrEntityID(input);
      if (!sessionID) {
        return;
      }

      runtime.prepareSessionContext(sessionID);
    },
    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const agentName =
        input.agent ??
        (typeof output.message.agent === "string"
          ? output.message.agent
          : undefined);
      runtime.setSessionAgent(input.sessionID, agentName);
      const locale = detectLocaleFromTexts(
        extractTextParts(output.parts ?? []),
      );
      runtime.setSessionLocale(input.sessionID, locale);

      if (
        config.memory?.enabled === false &&
        config.learning?.enabled === false
      ) {
        return;
      }

      // Skip previous-session context injection for subagents — they should
      // only see the task prompt they were spawned with, not stale context
      // from a prior primary session (which causes session mixing).
      if (agentName && !PRIMARY_AGENTS.has(agentName)) {
        return;
      }

      const injected = runtime.consumePendingInjection(input.sessionID, locale);
      if (!injected) {
        return;
      }

      const previousSystem =
        typeof output.message.system === "string"
          ? output.message.system.trim()
          : "";
      output.message.system = previousSystem
        ? `${previousSystem}\n\n${injected}`
        : injected;
    },
  };
}
