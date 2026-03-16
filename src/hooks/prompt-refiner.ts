import type { PluginInput } from "@opencode-ai/plugin";

const INTERNAL_SESSION_TITLE = "[plugin] prompt-refiner";
const PLUGIN_SERVICE = "prompt-refiner";
const REFINER_AGENT_NAME = "prompt-refiner";
const DEFAULT_REFINER_MODEL = "anthropic/claude-haiku-4-5";

const internalSessionIDs = new Set<string>();
const pendingVisibleDebug = new Map<string, string>();
const processedFingerprints = new Map<string, string>();
/** Cache: fingerprint(originalText) → refinedText, so previous user messages
 *  get their refined version re-applied on every transform call. */
const refinedTextCache = new Map<string, string>();

function fingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `${hash}:${text.length}`;
}

const DEFAULT_REWRITE_SYSTEM_PROMPT = [
  "You are a prompt rewriter. You translate and refine user messages into clear English for a coding assistant.",
  "",
  "Rules:",
  "- Output ONLY the rewritten text. Nothing else.",
  "- NEVER add prefixes like 'User:', 'User says:', 'User message:', 'Rewritten:', 'Prompt:', 'Translation:' or ANY label.",
  "- If the message is in another language, translate it to English naturally.",
  "- For simple/short messages (greetings, acknowledgments, short questions), just translate them directly. Do not over-elaborate.",
  "- For longer requests, make them clearer and more actionable without expanding scope.",
  "- Preserve code, file paths, commands, identifiers, versions, and constraints exactly.",
  "- Do not add new requirements or assumptions the user did not express.",
  "- If the message is already good English, return it as-is or with minimal edits.",
  "- No commentary, no bullets, no quotes, no markdown fences.",
].join("\n");

type MessagePart = {
  type: string;
  text?: string;
  mime?: string;
  filename?: string;
  ignored?: boolean;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
};

type Message = {
  info?: { role?: string; sessionID?: string };
  parts?: MessagePart[];
};

function unwrap<T>(result: unknown): T | undefined {
  return result && typeof result === "object" && "data" in result
    ? (result as Record<string, T>).data
    : (result as T | undefined);
}

function getTextParts(parts: MessagePart[]): MessagePart[] {
  return parts.filter(
    (part) => part?.type === "text" && typeof part.text === "string",
  );
}

function describeNonTextParts(parts: MessagePart[]): string[] {
  const placeholders: string[] = [];
  for (const part of parts) {
    if (!part || part.type === "text") continue;
    if (part.type === "file") {
      const mime = part.mime ?? "";
      if (mime.startsWith("image/")) {
        placeholders.push("[image]");
      } else {
        const label = part.filename ?? mime ?? "file";
        placeholders.push(`\u00ABpasted ${label}\u00BB`);
      }
    }
  }
  return placeholders;
}

function buildRefineRequest(
  text: string,
  attachmentPlaceholders: string[],
): string {
  const lines = [
    "Rewrite the message inside <source_message> into English for a coding agent.",
    "Output ONLY the rewritten text, no labels or prefixes.",
  ];

  if (attachmentPlaceholders.length > 0) {
    lines.push(
      "",
      "The user attached: " + attachmentPlaceholders.join(", "),
      "Keep placeholders in the rewritten text where they logically belong.",
    );
  }

  lines.push("", "<source_message>", text, "</source_message>");
  return lines.join("\n");
}

function extractText(parts: MessagePart[]): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => (part.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

const PLUGIN_NOISE_PATTERNS = [
  /^\u25a3\s/,
  /^\u2192\s/,
  /^\[refined prompt\]/i,
  /^@\w+/,
  /tokens?\s+saved/i,
  /^Pruning\s*\(/i,
  /^Noise Removal/i,
  /^\[TodoContinuation\]/i,
];

function looksLikePluginMessage(text: string): boolean {
  return PLUGIN_NOISE_PATTERNS.some((re) => re.test(text.trim()));
}

function hasOnlyIgnoredOrSyntheticParts(parts: MessagePart[]): boolean {
  if (!parts || parts.length === 0) return true;
  return parts.every(
    (part) => part?.ignored === true || part?.synthetic === true,
  );
}

function shouldSkip(
  text: string,
  sessionID: string,
  parts: MessagePart[],
): boolean {
  if (!text) return true;
  if (internalSessionIDs.has(sessionID)) return true;
  if (/^\/\S+/.test(text)) return true;
  if (looksLikePluginMessage(text)) return true;
  if (hasOnlyIgnoredOrSyntheticParts(parts)) return true;
  return false;
}

function isUserMessage(message: Message): boolean {
  return message?.info?.role === "user";
}

function isAssistantMessage(message: Message): boolean {
  return message?.info?.role === "assistant";
}

/**
 * Strip `> **[refined prompt]** ...` prefixes from assistant messages
 * so the model never sees them in conversation history on subsequent turns.
 * The prefix is still rendered to the user via `experimental.text.complete`.
 */
function stripRefinedPromptFromHistory(messages: Message[]): void {
  for (const message of messages) {
    if (!isAssistantMessage(message) || !message.parts) continue;

    for (const part of message.parts) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      if (!part.text.startsWith("> **[refined prompt]**")) continue;

      const lines = part.text.split("\n");
      let i = 0;
      // Skip blockquote lines belonging to the [refined prompt] header
      while (i < lines.length && lines[i].startsWith(">")) {
        i++;
      }
      // Skip blank lines separating the header from the actual response
      while (i < lines.length && lines[i].trim() === "") {
        i++;
      }
      part.text = lines.slice(i).join("\n");
    }
  }
}

/**
 * Re-apply cached refinements to ALL user messages in the conversation.
 * The framework passes original (un-transformed) messages on every turn,
 * so without this step the model would see raw text from previous turns.
 */
function applyCachedRefinements(messages: Message[]): void {
  for (const message of messages) {
    if (!isUserMessage(message) || !message.parts) continue;
    if (isAlreadyRefined(message.parts)) continue;

    const text = extractText(getTextParts(message.parts));
    if (!text) continue;

    const fp = fingerprint(text);
    const cached = refinedTextCache.get(fp);
    if (cached && cached !== text) {
      message.parts = applyRewrite(message.parts, cached);
    }
  }
}

function isAlreadyRefined(parts: MessagePart[]): boolean {
  return parts?.some(
    (part) =>
      (part?.metadata as Record<string, unknown>)?.promptRefiner &&
      (
        (part.metadata as Record<string, unknown>).promptRefiner as Record<
          string,
          unknown
        >
      )?.refined,
  );
}

function applyRewrite(
  parts: MessagePart[],
  rewrittenText: string,
): MessagePart[] {
  let replaced = false;
  return parts.flatMap((part) => {
    if (part?.type !== "text") return [part];
    if (replaced) return [];
    replaced = true;
    return [
      {
        ...part,
        text: rewrittenText,
        metadata: {
          ...(part.metadata ?? {}),
          promptRefiner: { refined: true },
        },
      },
    ];
  });
}

function getLatestUserMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isUserMessage(messages[i])) return messages[i];
  }
  return undefined;
}

function parseModelSpec(
  spec: unknown,
): { providerID: string; modelID: string } | undefined {
  if (typeof spec !== "string") return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return undefined;

  return {
    providerID: trimmed.slice(0, slashIndex),
    modelID: trimmed.slice(slashIndex + 1),
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

async function getRuntimeSettings(
  client: PluginInput["client"],
  directory: string,
) {
  try {
    const config = unwrap<Record<string, unknown>>(
      await client.config.get({ query: { directory } }),
    );

    const agentConfig =
      ((config?.agent as Record<string, Record<string, unknown>>)?.[
        REFINER_AGENT_NAME
      ] as Record<string, unknown>) ?? {};
    const model =
      parseModelSpec(agentConfig.model) ??
      parseModelSpec(config?.small_model) ??
      parseModelSpec(DEFAULT_REFINER_MODEL);
    const systemPrompt =
      typeof agentConfig.prompt === "string" &&
      (agentConfig.prompt as string).trim()
        ? (agentConfig.prompt as string).trim()
        : DEFAULT_REWRITE_SYSTEM_PROMPT;
    const variant =
      typeof agentConfig.variant === "string" &&
      (agentConfig.variant as string).trim()
        ? (agentConfig.variant as string).trim()
        : undefined;

    return {
      disabled: normalizeBoolean(agentConfig.disable, false),
      visibleDebug: normalizeBoolean(agentConfig.visible_debug, true),
      model,
      variant,
      systemPrompt,
    };
  } catch {
    return {
      disabled: false,
      visibleDebug: true,
      model: parseModelSpec(DEFAULT_REFINER_MODEL),
      variant: undefined,
      systemPrompt: DEFAULT_REWRITE_SYSTEM_PROMPT,
    };
  }
}

async function log(
  client: PluginInput["client"],
  level: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  try {
    await client.app.log({
      body: {
        service: PLUGIN_SERVICE,
        level: level as "error" | "info" | "debug" | "warn",
        message,
        extra,
      },
    });
  } catch {
    // swallow
  }
}

export function createPromptRefinerHook(ctx: PluginInput) {
  const { client, directory } = ctx;

  return {
    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: { messages?: Message[] },
    ) => {
      // 1. Strip [refined prompt] prefixes from assistant messages
      //    so the model never sees debug annotations in conversation history.
      stripRefinedPromptFromHistory(output.messages ?? []);

      // 2. Re-apply cached refinements to ALL previous user messages.
      //    The framework passes original texts each turn; without this
      //    the model would see un-refined messages from earlier turns.
      applyCachedRefinements(output.messages ?? []);

      const targetMessage = getLatestUserMessage(output.messages ?? []);
      const sessionID = targetMessage?.info?.sessionID;
      const originalText = extractText(
        getTextParts(targetMessage?.parts ?? []),
      );

      if (
        !targetMessage ||
        !sessionID ||
        shouldSkip(originalText, sessionID, targetMessage.parts ?? [])
      )
        return;
      if (isAlreadyRefined(targetMessage.parts ?? [])) return;

      // Fingerprint gate: only process genuinely new user messages.
      // Same text = same fingerprint = skip (handles re-renders, tool cycles, compaction).
      const fp = fingerprint(originalText);
      if (processedFingerprints.get(sessionID) === fp) return;
      processedFingerprints.set(sessionID, fp);

      const runtime = await getRuntimeSettings(client, directory);
      if (runtime.disabled) return;

      const attachmentPlaceholders = describeNonTextParts(
        targetMessage.parts ?? [],
      );
      let rewriteSessionID: string | undefined;

      try {
        const created = unwrap<{ id?: string }>(
          await client.session.create({
            body: { title: INTERNAL_SESSION_TITLE },
          }),
        );

        rewriteSessionID = created?.id;
        if (!rewriteSessionID) return;

        internalSessionIDs.add(rewriteSessionID);

        const promptBody = {
          model: runtime.model,
          system: runtime.systemPrompt,
          tools: {},
          parts: [
            {
              type: "text" as const,
              text: buildRefineRequest(originalText, attachmentPlaceholders),
            },
          ],
          ...(runtime.variant ? { variant: runtime.variant } : {}),
        };

        const response = unwrap<{ parts?: MessagePart[] }>(
          await client.session.prompt({
            path: { id: rewriteSessionID },
            body: promptBody as any,
          }),
        );

        const rewrittenText = extractText(response?.parts ?? []);
        if (!rewrittenText || rewrittenText === originalText) return;

        if (runtime.visibleDebug)
          pendingVisibleDebug.set(sessionID, rewrittenText);
        else pendingVisibleDebug.delete(sessionID);

        // Cache the refinement so it can be re-applied on future turns.
        refinedTextCache.set(fp, rewrittenText);

        targetMessage.parts = applyRewrite(
          targetMessage.parts ?? [],
          rewrittenText,
        );
      } catch (error) {
        await log(client, "warn", "Prompt refinement failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (rewriteSessionID) {
          internalSessionIDs.delete(rewriteSessionID);
          try {
            await client.session.delete({ path: { id: rewriteSessionID } });
          } catch {
            await log(
              client,
              "debug",
              "Failed to delete prompt refiner session",
              {
                sessionID: rewriteSessionID,
              },
            );
          }
        }
      }
    },

    "experimental.text.complete": async (
      input: { sessionID?: string },
      output: { text?: string },
    ) => {
      const rewrittenText = pendingVisibleDebug.get(input.sessionID ?? "");
      if (!rewrittenText || !output.text) return;

      pendingVisibleDebug.delete(input.sessionID ?? "");
      const quotedRewrite = rewrittenText
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      output.text = `> **[refined prompt]**\n${quotedRewrite}\n\n${output.text}`;
    },
  };
}
