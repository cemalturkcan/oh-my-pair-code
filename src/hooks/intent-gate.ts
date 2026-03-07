import type { PluginInput } from "@opencode-ai/plugin";
import type { HarnessMode } from "../types";

type ChatMessageInput = {
  sessionID: string;
  agent?: string;
};

type ChatMessageOutput = {
  message: Record<string, unknown>;
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
};

type IntentClassification = {
  mode: HarnessMode;
  confidence: "low" | "medium" | "high";
  reason: string;
  guidance: string;
};

function extractPromptText(parts: ChatMessageOutput["parts"]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function classifyIntent(text: string): IntentClassification {
  const source = text.toLowerCase();

  const autonomousSignals = [
    "autonomous",
    "end-to-end",
    "take it from here",
    "handle it",
    "run with it",
    "you can proceed",
    "finish it",
    "implement it fully",
  ];

  const pairSignals = [
    "with me",
    "pair",
    "together",
    "let's decide",
    "bring me options",
    "ask me",
    "consult me",
  ];

  if (autonomousSignals.some((signal) => source.includes(signal))) {
    return {
      mode: "autonomous",
      confidence: "high",
      reason: "The user explicitly asked for autonomous or end-to-end execution.",
      guidance: "Use checkpointed autonomy. Inspect first, choose the best repo-consistent defaults, and execute independently without asking for permission.",
    };
  }

  if (pairSignals.some((signal) => source.includes(signal))) {
    return {
      mode: "pair",
      confidence: "high",
      reason: "The user asked for collaborative decision-making or explicit consultation.",
      guidance: "Work as a technical pair programmer. Stay transparent, recommend the best option, and continue implementation without waiting for approval unless a missing external value makes execution impossible.",
    };
  }

  if (source.includes("research") || source.includes("compare") || source.includes("which library") || source.includes("which package")) {
    return {
      mode: "pair",
      confidence: "medium",
      reason: "The user appears to want decision support before implementation.",
      guidance: "Prioritize discovery and recommendation quality, then choose the safest repo-consistent option and continue.",
    };
  }

  return {
    mode: "pair",
    confidence: "low",
    reason: "No strong autonomous signal was detected, so collaborative mode is safer by default.",
    guidance: "Stay collaborative by default, but do not over-question. Choose repo-consistent defaults and keep moving.",
  };
}

function buildSystemInjection(classification: IntentClassification): string {
  return [
    "[IntentGate]",
    `Detected mode: ${classification.mode}`,
    `Confidence: ${classification.confidence}`,
    `Reason: ${classification.reason}`,
    `Direction: ${classification.guidance}`,
    "Keep all internal coordination in English.",
    "Reply to the user in the user's language, but do not mimic degraded spelling or broken keyboard habits.",
    "The user has already granted implementation authority inside the task scope.",
    "Do not ask for permission or confirmation unless execution is impossible without user-provided external data.",
  ].join("\n");
}

export function createIntentGateHook(_ctx: PluginInput) {
  return {
    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput): Promise<void> => {
      const text = extractPromptText(output.parts);
      if (!text) {
        return;
      }

      const classification = classifyIntent(text);
      const currentAgent = typeof input.agent === "string"
        ? input.agent
        : (typeof output.message.agent === "string" ? output.message.agent : undefined);

      if (!currentAgent || currentAgent === "pair" || currentAgent === "autonomous") {
        output.message.agent = classification.mode;
      }

      const previousSystem = typeof output.message.system === "string" ? output.message.system.trim() : "";
      const injected = buildSystemInjection(classification);
      output.message.system = previousSystem ? `${previousSystem}\n\n${injected}` : injected;
    },
  };
}
