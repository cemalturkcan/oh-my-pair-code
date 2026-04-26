import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { joinProjectFactLabels } from "../project-facts";
import type { HarnessConfig } from "../types";
import type { HookRuntime } from "./runtime";
import { PRIMARY_AGENTS } from "./runtime";

type ChatMessageInput = {
  sessionID: string;
  agent?: string;
};

type ChatMessageOutput = {
  message: Record<string, unknown>;
  parts?: Array<Record<string, unknown>>;
};

const WICK_SHORTCUT = /^\s*wick!\s*/i;
const WICK_SHORTCUT_MODEL = {
  providerID: "openai",
  modelID: "gpt-5.5-fast",
  variant: "xhigh",
};

function applyWickShortcut(output: ChatMessageOutput): boolean {
  if (!Array.isArray(output.parts)) return false;

  for (const part of output.parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (!WICK_SHORTCUT.test(part.text)) return false;

    const nextText = part.text.replace(WICK_SHORTCUT, "");
    if (nextText.trim().length > 0) {
      part.text = nextText;
    }
    output.message.agent = "wick";
    output.message.model = WICK_SHORTCUT_MODEL;
    return true;
  }

  return false;
}

function compactFactList(values: string[]): string {
  return values.length > 0 ? values.join("/") : "-";
}

function buildSubagentProjectContext(
  config: HarnessConfig,
  runtime: HookRuntime,
): string {
  const facts = runtime.detectProjectFacts();
  if (config.workflow?.compact_subagent_context !== false) {
    return `[ProjectContext] pkg=${facts.packageManager} lang=${compactFactList(
      facts.languages,
    )} fw=${compactFactList(facts.frameworks)}`;
  }

  const languages =
    facts.languages.length > 0 ? joinProjectFactLabels(facts.languages) : "unknown";
  const frameworks =
    facts.frameworks.length > 0 ? joinProjectFactLabels(facts.frameworks) : "none";
  return `[ProjectContext] packageManager: ${facts.packageManager} | languages: ${languages} | frameworks: ${frameworks}`;
}

function detectProjectDocs(directory: string): string[] {
  const candidates = [
    "AGENTS.md",
    "README.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
  ];
  return candidates.filter((name) => existsSync(join(directory, name)));
}

function buildResourceInjection(directory: string): string {
  const docs = detectProjectDocs(directory);
  if (docs.length === 0) {
    return "";
  }

  return `[ProjectDocs] Available: ${docs.join(", ")}. Read these before starting domain-specific work.`;
}

export function createSessionStartHook(
  ctx: PluginInput,
  config: HarnessConfig,
  runtime: HookRuntime,
) {
  return {
    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      applyWickShortcut(output);

      const agentName =
        (typeof output.message.agent === "string"
          ? output.message.agent
          : undefined) ?? input.agent;
      runtime.setSessionAgent(input.sessionID, agentName);

      if (agentName && !PRIMARY_AGENTS.has(agentName)) {
        const injectionParts = [
          buildSubagentProjectContext(config, runtime),
          runtime.buildSubagentTaskInjection(input.sessionID),
        ].filter(Boolean);
        const previousSystem =
          typeof output.message.system === "string"
            ? output.message.system.trim()
            : "";
        output.message.system = previousSystem
          ? `${previousSystem}\n\n${injectionParts.join("\n\n")}`
          : injectionParts.join("\n\n");
        return;
      }

      const injectionParts = [
        runtime.buildPrimaryInjection(),
        buildResourceInjection(ctx.directory),
        runtime.buildSubagentTaskInjection(input.sessionID),
      ].filter(Boolean);

      if (injectionParts.length === 0) {
        return;
      }

      const injection = injectionParts.join("\n\n");
      const previousSystem =
        typeof output.message.system === "string"
          ? output.message.system.trim()
          : "";
      output.message.system = previousSystem
        ? `${previousSystem}\n\n${injection}`
        : injection;
    },
  };
}
