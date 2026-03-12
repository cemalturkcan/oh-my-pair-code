import type { PluginInput } from "@opencode-ai/plugin";
import { unwrapData } from "./sdk";

type Todo = {
  content: string;
  status: string;
  priority: string;
  id: string;
};

type MessageWithParts = {
  info?: {
    id?: string;
    role?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    providerID?: string;
    modelID?: string;
  };
  parts?: Array<{ type?: string; text?: string }>;
};

type IdleState = {
  lastInjectedAt?: number;
  lastBusyAt?: number;
  lastIdleAt?: number;
  inFlight: boolean;
};

type PendingPromptState = {
  sessionID?: string;
  text: string;
  submitRequested: boolean;
};

type EventInput = {
  event: {
    type: string;
    properties?: unknown;
  };
};

function clearPendingPrompt(state: PendingPromptState): void {
  state.sessionID = undefined;
  state.text = "";
  state.submitRequested = false;
}

function hasPendingDraft(state: PendingPromptState): boolean {
  return state.text.trim().length > 0;
}

function isSessionBusy(state: IdleState): boolean {
  if (!state.lastBusyAt) {
    return false;
  }

  return !state.lastIdleAt || state.lastBusyAt > state.lastIdleAt;
}

function resolveSessionIDFromInfo(properties: unknown): string | undefined {
  const info = (properties as { info?: { id?: string } } | undefined)?.info;
  return typeof info?.id === "string" ? info.id : undefined;
}

function resolveSelectedSessionID(properties: unknown): string | undefined {
  return (properties as { sessionID?: string } | undefined)?.sessionID;
}

function resolveCommand(properties: unknown): string | undefined {
  return (properties as { command?: string } | undefined)?.command;
}

function isIncomplete(todo: Todo): boolean {
  return !["completed", "cancelled", "blocked", "deleted"].includes(todo.status);
}

function extractAssistantText(message: MessageWithParts | undefined): string {
  if (!message?.parts) {
    return "";
  }

  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function hasPendingQuestion(messages: MessageWithParts[]): boolean {
  const lastAssistant = [...messages].reverse().find((message) => message.info?.role === "assistant");
  const lastUser = [...messages].reverse().find((message) => message.info?.role === "user");

  if (!lastAssistant?.info?.id) {
    return false;
  }

  if (lastUser?.info?.id === lastAssistant.info.id) {
    return false;
  }

  const assistantText = extractAssistantText(lastAssistant).toLowerCase();
  if (!assistantText) {
    return false;
  }

  const questionSignals = [
    "?",
    "which option",
    "which one",
    "what do you want",
    "how do you want",
    "should i",
    "do you want",
    "which direction",
  ];

  return questionSignals.some((signal) => assistantText.includes(signal));
}

function resolvePromptTarget(messages: MessageWithParts[]): {
  agent?: string;
  model?: { providerID: string; modelID: string };
} {
  const lastUser = [...messages].reverse().find((message) => message.info?.role === "user");
  if (!lastUser?.info) {
    return {};
  }

  const model = lastUser.info.model ?? (
    lastUser.info.providerID && lastUser.info.modelID
      ? { providerID: lastUser.info.providerID, modelID: lastUser.info.modelID }
      : undefined
  );

  return {
    agent: lastUser.info.agent,
    model,
  };
}

function buildContinuationPrompt(incompleteTodos: Todo[]): string {
  const todoList = incompleteTodos
    .map((todo) => `- [${todo.status}] ${todo.content}`)
    .join("\n");

  return [
    "[TodoContinuation]",
    "The session went idle while there are still incomplete todos.",
    "Resume work now. Do not restate the entire prior breakdown.",
    "Continue from the highest-leverage unfinished item.",
    "Do not ask for permission or confirmation.",
    "Choose the safest repo-consistent default when details are ambiguous.",
    "Only report a blocker if a missing secret, credential, account-specific value, or external artifact makes execution impossible.",
    "Remaining todos:",
    todoList,
  ].join("\n\n");
}

export function createTodoContinuationHook(ctx: PluginInput, cooldownMs: number, flushQueuedPrompts: boolean) {
  const state = new Map<string, IdleState>();
  const pendingPrompt: PendingPromptState = {
    text: "",
    submitRequested: false,
  };
  let activeSessionID: string | undefined;

  const getSessionState = (sessionID: string): IdleState => {
    const sessionState = state.get(sessionID) ?? { inFlight: false };
    state.set(sessionID, sessionState);
    return sessionState;
  };

  const submitQueuedPrompt = async (sessionID: string): Promise<boolean> => {
    if (!flushQueuedPrompts) {
      return false;
    }

    if (!pendingPrompt.submitRequested || pendingPrompt.sessionID !== sessionID) {
      return false;
    }

    if (activeSessionID && activeSessionID !== sessionID) {
      return false;
    }

    const sessionState = getSessionState(sessionID);
    if (sessionState.inFlight) {
      return true;
    }

    sessionState.inFlight = true;
    try {
      await ctx.client.tui.submitPrompt({ query: { directory: ctx.directory } });
      clearPendingPrompt(pendingPrompt);
      return true;
    } finally {
      sessionState.inFlight = false;
    }
  };

  return {
    event: async ({ event }: EventInput): Promise<void> => {
      if (event.type === "tui.session.select") {
        const sessionID = resolveSelectedSessionID(event.properties);
        if (!sessionID) {
          return;
        }

        activeSessionID = sessionID;
        const sessionState = getSessionState(sessionID);
        if (pendingPrompt.submitRequested && pendingPrompt.sessionID === sessionID && !isSessionBusy(sessionState)) {
          await submitQueuedPrompt(sessionID);
        }
        return;
      }

      if (event.type === "session.created" || event.type === "session.updated") {
        const sessionID = resolveSessionIDFromInfo(event.properties);
        if (!sessionID) {
          return;
        }

        const sessionState = getSessionState(sessionID);
        sessionState.lastBusyAt = Date.now();
        activeSessionID = activeSessionID ?? sessionID;
        return;
      }

      if (event.type === "tui.prompt.append") {
        if (!flushQueuedPrompts || !activeSessionID) {
          return;
        }

        const sessionState = getSessionState(activeSessionID);
        if (!isSessionBusy(sessionState)) {
          return;
        }

        const text = (event.properties as { text?: string } | undefined)?.text;
        if (typeof text !== "string" || text.length === 0) {
          return;
        }

        if (!pendingPrompt.sessionID) {
          pendingPrompt.sessionID = activeSessionID;
        }

        if (pendingPrompt.sessionID !== activeSessionID) {
          return;
        }

        pendingPrompt.text += text;
        return;
      }

      if (event.type === "tui.command.execute") {
        const command = resolveCommand(event.properties);
        if (!command) {
          return;
        }

        if (command === "prompt.clear") {
          clearPendingPrompt(pendingPrompt);
          return;
        }

        if (command !== "prompt.submit" || !flushQueuedPrompts || !activeSessionID) {
          return;
        }

        const sessionState = getSessionState(activeSessionID);
        if (!isSessionBusy(sessionState)) {
          clearPendingPrompt(pendingPrompt);
          return;
        }

        pendingPrompt.sessionID = pendingPrompt.sessionID ?? activeSessionID;
        if (pendingPrompt.sessionID !== activeSessionID) {
          return;
        }

        pendingPrompt.submitRequested = true;
        return;
      }

      if (event.type !== "session.idle") {
        return;
      }

      const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID;
      if (!sessionID) {
        return;
      }

      activeSessionID = activeSessionID ?? sessionID;
      const sessionState = getSessionState(sessionID);
      sessionState.lastIdleAt = Date.now();

      if (sessionState.inFlight) {
        return;
      }

      if (await submitQueuedPrompt(sessionID)) {
        return;
      }

      if (flushQueuedPrompts && pendingPrompt.sessionID === sessionID && hasPendingDraft(pendingPrompt)) {
        return;
      }

      if (sessionState.lastInjectedAt && Date.now() - sessionState.lastInjectedAt < cooldownMs) {
        return;
      }

      const todosResponse = await ctx.client.session.todo({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      }).catch(() => null);
      const todos = unwrapData<Todo[]>(todosResponse, []);
      const incompleteTodos = todos.filter(isIncomplete);
      if (incompleteTodos.length === 0) {
        return;
      }

      const messagesResponse = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory, limit: 24 },
      }).catch(() => null);
      const messages = unwrapData<MessageWithParts[]>(messagesResponse, []);
      if (hasPendingQuestion(messages)) {
        return;
      }

      const target = resolvePromptTarget(messages);
      const prompt = buildContinuationPrompt(incompleteTodos);
      sessionState.inFlight = true;

      try {
        await ctx.client.session.promptAsync({
          path: { id: sessionID },
          body: {
            ...(target.agent ? { agent: target.agent } : {}),
            ...(target.model ? { model: target.model } : {}),
            parts: [{ type: "text", text: prompt }],
          },
          query: { directory: ctx.directory },
        });
        sessionState.lastInjectedAt = Date.now();
      } finally {
        sessionState.inFlight = false;
      }
    },
  };
}
