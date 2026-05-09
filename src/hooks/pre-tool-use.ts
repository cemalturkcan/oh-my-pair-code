import type { HookProfile } from "../types";
import type { HookRuntime } from "./runtime";
import {
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

export function createPreToolUseHook(
  runtime: HookRuntime,
  _profile: HookProfile,
) {
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

      if (sessionID && tool) {
        runtime.getSessionAgent(sessionID);
      }
    },
  };
}
