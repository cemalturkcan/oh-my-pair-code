import type { HarnessConfig } from "../types";
import type { HookRuntime } from "./runtime";
import { BlockingHookError } from "./sdk";
import { profileMatches, resolveAgentName, resolveFilePathFromArgs, resolveSessionID, resolveToolArgs, resolveToolName } from "./runtime";

function isLongRunningCommand(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)\s+(install|build|test|run)|^cargo\s+(build|test|run)|^go\s+(build|test|run)/.test(command);
}

function extractPatchedPaths(patchText: string): string[] {
  const matches = patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm);
  return [...matches].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function isPairPlanReadOnlyCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  if (/(&&|\|\||;|>|<|\||`|\$\(|\n|\r)/.test(normalized)) {
    return false;
  }

  const allowlist = [
    /^pwd$/,
    /^ls(?:\s+.+)?$/,
    /^find\s+.+$/,
    /^cat\s+.+$/,
    /^head(?:\s+.+)?$/,
    /^tail(?:\s+.+)?$/,
    /^sed\s+-n\s+.+$/,
    /^rg(?:\s+.+)?$/,
    /^grep(?:\s+.+)?$/,
    /^wc(?:\s+.+)?$/,
    /^stat\s+.+$/,
    /^file\s+.+$/,
    /^git\s+(?:--no-pager\s+)?status(?:\s+.+)?$/,
    /^git\s+(?:--no-pager\s+)?diff(?:\s+.+)?$/,
    /^git\s+(?:--no-pager\s+)?log(?:\s+.+)?$/,
    /^git\s+(?:--no-pager\s+)?show(?:\s+.+)?$/,
    /^git\s+(?:--no-pager\s+)?grep(?:\s+.+)?$/,
    /^git\s+(?:--no-pager\s+)?blame(?:\s+.+)?$/,
    /^git\s+(?:--no-pager\s+)?shortlog(?:\s+.+)?$/,
    /^git\s+branch(?:\s+.+)?$/,
    /^git\s+tag(?:\s+.+)?$/,
    /^git\s+remote\s+-v(?:\s+.+)?$/,
    /^git\s+reflog(?:\s+.+)?$/,
    /^git\s+rev-parse(?:\s+.+)?$/,
    /^git\s+ls-files(?:\s+.+)?$/,
    /^git\s+describe(?:\s+.+)?$/,
  ];

  return allowlist.some((pattern) => pattern.test(normalized));
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
      const agent = (sessionID ? runtime.getSessionAgent(sessionID) : undefined) ?? resolveAgentName(input);

      if (sessionID) {
        runtime.incrementToolCount(sessionID);
      }

      if (agent === "pair-plan") {
        if (tool === "edit") {
          throw new BlockingHookError("pair-plan is planning-only. Use `pair` or `autonomous` for bash or non-Markdown edits.");
        }

        if (tool === "bash") {
          const command = typeof args.command === "string" ? args.command : "";
          if (!isPairPlanReadOnlyCommand(command)) {
            throw new BlockingHookError("pair-plan only allows read-only shell commands for repo and git state inspection.");
          }
        }

        if (tool === "write") {
          const filePath = resolveFilePathFromArgs(args);
          if (filePath && !filePath.toLowerCase().endsWith(".md")) {
            throw new BlockingHookError("pair-plan can only write Markdown files.");
          }
        }

        if (tool === "apply_patch") {
          const patchText = typeof args.patchText === "string" ? args.patchText : "";
          const patchedPaths = extractPatchedPaths(patchText);
          if (patchedPaths.length === 0 || patchedPaths.some((filePath) => !filePath.toLowerCase().endsWith(".md"))) {
            throw new BlockingHookError("pair-plan can only patch Markdown files.");
          }
        }
      }

      if (sessionID && runtime.shouldSuggestCompact(sessionID) && profileMatches(profile, ["standard", "strict"])) {
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
