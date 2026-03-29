import type { HarnessConfig } from "../types";
import type { HookRuntime } from "./runtime";
import { BlockingHookError } from "./sdk";
import {
  profileMatches,
  resolveAgentName,
  resolveFilePathFromArgs,
  resolveSessionID,
  resolveToolArgs,
  resolveToolName,
} from "./runtime";

function isLongRunningCommand(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)\s+(install|build|test|run)|^cargo\s+(build|test|run)|^go\s+(build|test|run)/.test(
    command,
  );
}

function extractPatchedPaths(patchText: string): string[] {
  const matches = patchText.matchAll(
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
  );
  return [...matches]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

export function createPreToolUseHook(
  config: HarnessConfig,
  runtime: HookRuntime,
  profile: import("../types").HookProfile,
) {
  return {
    "tool.execute.before": async (input: unknown): Promise<void> => {
      const sessionID = resolveSessionID(input);
      const tool = resolveToolName(input);
      const args = resolveToolArgs(input);
      const agent =
        (sessionID ? runtime.getSessionAgent(sessionID) : undefined) ??
        resolveAgentName(input);

      if (sessionID) {
        runtime.incrementToolCount(sessionID);
      }

      if (
        sessionID &&
        runtime.shouldSuggestCompact(sessionID) &&
        profileMatches(profile, ["standard", "strict"])
      ) {
        runtime.appendObservation({
          timestamp: new Date().toISOString(),
          phase: "pre",
          sessionID,
          agent,
          tool,
          note: "compact_suggested",
        });
      }

      if (tool === "bash" && profileMatches(profile, "strict")) {
        const command = typeof args.command === "string" ? args.command : "";
        if (isLongRunningCommand(command)) {
          runtime.appendObservation({
            timestamp: new Date().toISOString(),
            phase: "pre",
            sessionID,
            agent,
            tool,
            note: "prefer_pty_for_long_running_command",
          });
        }
      }

      runtime.appendObservation({
        timestamp: new Date().toISOString(),
        phase: "pre",
        sessionID,
        agent,
        tool,
      });
    },
  };
}
