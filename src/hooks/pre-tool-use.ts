import type { HookProfile } from "../types";
import type { HookRuntime } from "./runtime";
import { BlockingHookError } from "./sdk";
import {
  profileMatches,
  resolveSessionID,
  resolveToolArgs,
  resolveToolName,
} from "./runtime";

const NODE_COMMAND_RE =
  /^(npm|pnpm|yarn|bun|npx|bunx|node|tsc|tsx|vite|next|nuxt|vitest|jest|eslint|prettier)\b/;

const NODE_MODULES_BIN_RE = /node_modules\/\.bin\//;

function hasToolArgs(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}

function resolveEffectiveToolArgs(
  input: unknown,
  output: unknown,
): Record<string, unknown> {
  const inputArgs = resolveToolArgs(input);
  const outputArgs = resolveToolArgs(output);
  if (!hasToolArgs(outputArgs)) {
    return inputArgs;
  }

  for (const [key, value] of Object.entries(inputArgs)) {
    if (!(key in outputArgs)) {
      outputArgs[key] = value;
    }
  }

  return outputArgs;
}

function isNodeCommand(command: string): boolean {
  return (
    NODE_COMMAND_RE.test(command.trim()) || NODE_MODULES_BIN_RE.test(command)
  );
}

function transformToCmd(command: string, winPath: string): string {
  return `cmd.exe /c "cd ${winPath} && ${command}"`;
}

function hasRecentBuildCheck(recentTools: string[]): boolean {
  return recentTools.some(
    (tool) =>
      tool.includes("tsc") ||
      tool.includes("typecheck") ||
      tool.includes("build") ||
      tool.includes("test"),
  );
}

export function createPreToolUseHook(
  runtime: HookRuntime,
  profile: HookProfile,
) {
  const recentBashBySession = new Map<string, string[]>();

  return {
    "tool.execute.before": async (
      input: unknown,
      output: unknown,
    ): Promise<void> => {
      const sessionID = resolveSessionID(input);
      const tool = resolveToolName(input);
      const args = resolveEffectiveToolArgs(input, output);

      if (
        tool === "bash" &&
        runtime.isWsl() &&
        typeof args.command === "string"
      ) {
        const command = args.command.trim();
        if (isNodeCommand(command)) {
          (args as Record<string, unknown>).command = transformToCmd(
            command,
            runtime.getWslWinPath(),
          );
        }
      }

      if (
        tool === "bash" &&
        typeof args.command === "string" &&
        args.command.includes("git push") &&
        profileMatches(profile, ["standard", "strict"])
      ) {
        const sessionCmds = sessionID
          ? (recentBashBySession.get(sessionID) ?? [])
          : [];
        if (!hasRecentBuildCheck(sessionCmds)) {
          throw new BlockingHookError(
            "[Safety] No build/typecheck detected before git push. Run typecheck first, then push.",
          );
        }
      }

      if (tool === "bash" && typeof args.command === "string" && sessionID) {
        const commands = recentBashBySession.get(sessionID) ?? [];
        commands.push(args.command);
        if (commands.length > 10) {
          commands.shift();
        }
        recentBashBySession.set(sessionID, commands);
      }
    },
  };
}
