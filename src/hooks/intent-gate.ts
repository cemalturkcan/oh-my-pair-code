import type { PluginInput } from "@opencode-ai/plugin";
import { extractTextParts, getAllSignals, matchesAnySignal } from "../i18n";
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

type ModeState = {
  mode: HarnessMode;
  source: "explicit" | "inferred";
  enteredFrom?: HarnessMode;
};

function classifyIntent(text: string): IntentClassification {
  if (matchesAnySignal(text, getAllSignals("intent", "autonomous"))) {
    return {
      mode: "autonomous",
      confidence: "high",
      reason: "The user explicitly asked for autonomous or end-to-end execution.",
      guidance: "Use checkpointed autonomy. Inspect first, choose the best repo-consistent defaults, and execute independently without asking for permission.",
    };
  }

  if (matchesAnySignal(text, getAllSignals("intent", "pair_plan"))) {
    return {
      mode: "pair-plan",
      confidence: "high",
      reason: "The user explicitly asked for planning-first behavior.",
      guidance: "Stay in planning mode. Read broadly, reason concretely, and only write Markdown artifacts when they help the task move forward.",
    };
  }

  if (matchesAnySignal(text, getAllSignals("intent", "pair"))) {
    return {
      mode: "pair",
      confidence: "high",
      reason: "The user asked for collaborative decision-making or explicit consultation.",
      guidance: "Work as a technical pair programmer. Stay transparent, make agreement or disagreement explicit, and continue implementation without waiting for approval unless a missing external value makes execution impossible.",
    };
  }

  if (matchesAnySignal(text, getAllSignals("intent", "research"))) {
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

function toHarnessMode(value: string | undefined): HarnessMode | undefined {
  return value === "pair" || value === "pair-plan" || value === "autonomous" ? value : undefined;
}

function resolveExplicitState(previous: ModeState | undefined, currentAgent: HarnessMode | undefined): ModeState | undefined {
  if (!currentAgent) {
    return previous;
  }

  if (!previous || previous.mode !== currentAgent) {
    return {
      mode: currentAgent,
      source: "explicit",
    };
  }

  return previous;
}

function applyModeState(
  currentState: ModeState | undefined,
  classification: IntentClassification,
): { state: ModeState; classification: IntentClassification } {
  if (!currentState) {
    return {
      state: {
        mode: classification.mode,
        source: "inferred",
      },
      classification,
    };
  }

  if (classification.mode === currentState.mode) {
    return {
      state: currentState,
      classification,
    };
  }

  if (currentState.mode === "pair" && classification.mode === "pair-plan") {
    return {
      state: {
        mode: "pair-plan",
        source: "inferred",
        enteredFrom: "pair",
      },
      classification,
    };
  }

  if (
    currentState.mode === "pair-plan"
    && currentState.source === "inferred"
    && currentState.enteredFrom === "pair"
    && classification.mode === "pair"
  ) {
    return {
      state: {
        mode: "pair",
        source: "inferred",
      },
      classification,
    };
  }

  if (currentState.mode === "pair-plan" && currentState.source === "explicit" && classification.mode === "pair") {
    return {
      state: currentState,
      classification: {
        mode: "pair-plan",
        confidence: classification.confidence === "low" ? "medium" : classification.confidence,
        reason: "An explicitly selected pair-plan session stays in planning mode until the user explicitly switches modes.",
        guidance: "Stay in planning mode. Read broadly, reason concretely, and only write Markdown artifacts when they help the task move forward.",
      },
    };
  }

  return {
    state: {
      mode: classification.mode,
      source: "inferred",
      enteredFrom: currentState.mode,
    },
    classification,
  };
}

export function createIntentGateHook(_ctx: PluginInput) {
  const sessionModes = new Map<string, ModeState>();

  return {
    "chat.message": async (input: ChatMessageInput, output: ChatMessageOutput): Promise<void> => {
      const text = extractTextParts(output.parts);
      if (!text) {
        return;
      }

      const classification = classifyIntent(text);
      const currentAgent = toHarnessMode(typeof input.agent === "string"
        ? input.agent
        : (typeof output.message.agent === "string" ? output.message.agent : undefined));
      const explicitState = resolveExplicitState(sessionModes.get(input.sessionID), currentAgent);
      const resolved = applyModeState(explicitState, classification);
      sessionModes.set(input.sessionID, resolved.state);

      if (!currentAgent || currentAgent === "pair" || currentAgent === "pair-plan" || currentAgent === "autonomous") {
        output.message.agent = resolved.classification.mode;
      }

      const previousSystem = typeof output.message.system === "string" ? output.message.system.trim() : "";
      const injected = buildSystemInjection(resolved.classification);
      output.message.system = previousSystem ? `${previousSystem}\n\n${injected}` : injected;
    },
  };
}
