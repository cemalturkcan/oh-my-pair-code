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
  inFlight: boolean;
};

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

export function createTodoContinuationHook(ctx: PluginInput, cooldownMs: number) {
  const state = new Map<string, IdleState>();

  return {
    event: async ({ event }: { event: { type: string; properties?: unknown } }): Promise<void> => {
      if (event.type !== "session.idle") {
        return;
      }

      const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID;
      if (!sessionID) {
        return;
      }

      const sessionState = state.get(sessionID) ?? { inFlight: false };
      state.set(sessionID, sessionState);

      if (sessionState.inFlight) {
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
