import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { runLedgerSyncStartPull, type LedgerSyncRunner } from "../orchestrator/sync";
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
};

function compactFactList(values: string[]): string {
  return values.length > 0 ? values.join("/") : "-";
}

function buildWorkerProjectContext(
  config: HarnessConfig,
  runtime: HookRuntime,
): string {
  const facts = runtime.detectProjectFacts();
  if (config.workflow?.compact_worker_context !== false) {
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
  syncRunner?: LedgerSyncRunner,
) {
  const pulledSessions = new Set<string>();
  return {
    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const agentName =
        (typeof output.message.agent === "string"
          ? output.message.agent
          : undefined) ?? input.agent;
      runtime.setSessionAgent(input.sessionID, agentName);
      if (!pulledSessions.has(input.sessionID)) {
        pulledSessions.add(input.sessionID);
        const sync = await runLedgerSyncStartPull(ctx.directory, config, syncRunner);
        for (const warning of sync.warnings.filter((item) => item.includes("failed") || item.includes("skipped") || item.includes("does not exist"))) {
          console.warn(`[opencode-pair] ledger sync start: ${warning}`);
        }
      }

      if (agentName && !PRIMARY_AGENTS.has(agentName)) {
        const injectionParts = [
          buildWorkerProjectContext(config, runtime),
          runtime.buildWorkerTaskInjection(input.sessionID, agentName),
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
        runtime.buildMissionControlInjection(input.sessionID),
        buildResourceInjection(ctx.directory),
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
